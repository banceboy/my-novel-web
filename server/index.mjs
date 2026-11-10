/**
 * 小书童网页版网关（生产入口）。
 *
 * 启动：node server/index.mjs
 *   - 会话鉴权：HttpOnly Cookie，服务端持有会话；用户无法自报 userId
 *   - 多租户：每个账号 fork 一个独立 RPC 进程，进程内数据根与模块状态完全隔离
 *   - 配额/任务队列：每日 AI 额度、上传/存储上限、全局并发与每用户串行
 *   - 单端口提供静态页面 + /api，不需要 Vite dev server
 *
 * 开发时仍可用 Vite dev server（5180）把 /api 代理到这里。
 * 环境变量见 .env.example。
 */
import http from 'node:http'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  initAuth, authenticate, login, logout, sessionCookie,
  clearSessionCookie, authStats, createUser, setDisabled, setPassword,
  setQuota, listUsers,
} from './auth.mjs'
import { TenantPool } from './tenant-pool.mjs'
import { QuotaManager, QuotaError } from './quota.mjs'
import { StaticHost, securityHeaders } from './static.mjs'

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
const DATA_ROOT = path.resolve(process.env.DATA_ROOT ?? './data')
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://${HOST}:${PORT}`
const STATIC_ROOT = path.resolve(process.env.STATIC_ROOT ?? './dist-web')
const MAX_AUTH_BODY = 16 * 1024
const MAX_RPC_BODY = 32 * 1024 * 1024
// 网关与租户进程之间的共享密钥：即使本机其它进程直连回环端口也无法冒充网关
const INTERNAL_TOKEN = process.env.XST_INTERNAL_TOKEN || randomBytes(32).toString('hex')

try {
  mkdirSync(DATA_ROOT, { recursive: true })
  initAuth()
} catch (error) {
  console.error(`[web] 启动失败（数据目录或账号库不可用）: ${error?.message ?? error}`)
  process.exit(1)
}

const pool = new TenantPool({ dataRoot: DATA_ROOT, internalToken: INTERNAL_TOKEN })
const quota = new QuotaManager({ dataRoot: DATA_ROOT })
const staticHost = new StaticHost(STATIC_ROOT)
const isProduction = process.env.NODE_ENV === 'production'

function isSecure(req) {
  if (new URL(PUBLIC_ORIGIN).protocol === 'https:') return true
  // 只有明确声明信任反向代理时才采信转发头，避免客户端伪造影响 Cookie 属性
  return process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https'
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new QuotaError(413, 'REQUEST_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function csrfOk(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true
  const origin = req.headers.origin
  if (!origin) return true // SameSite=Strict 兜底；CLI / curl 不带 Origin
  let parsed
  try { parsed = new URL(origin) }
  catch { return false }
  if (parsed.origin === new URL(PUBLIC_ORIGIN).origin) return true
  // 生产环境不隐式信任任何开发源；必须显式配置 ALLOWED_ORIGINS
  const defaultAllowed = isProduction ? '' : 'http://127.0.0.1:5180'
  const allowed = (process.env.ALLOWED_ORIGINS ?? defaultAllowed)
    .split(',').map(item => item.trim()).filter(Boolean)
  if (allowed.includes(parsed.origin)) return true
  if (!isProduction && ['127.0.0.1', 'localhost'].includes(parsed.hostname)) return true
  return false
}

async function handleLogin(req, res) {
  let payload
  try { payload = JSON.parse((await readBody(req, MAX_AUTH_BODY)).toString('utf8') || '{}') }
  catch { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST' } }); return }
  const result = login(req, payload?.username, payload?.password)
  if (result.error) {
    sendJson(res, result.error === 'TOO_MANY_ATTEMPTS' ? 429 : 401, {
      ok: false,
      error: { code: result.error, message: result.error === 'TOO_MANY_ATTEMPTS' ? '尝试过多，请稍后再试' : '账号或口令错误' },
    })
    return
  }
  sendJson(res, 200, { ok: true, user: result.user }, {
    'Set-Cookie': sessionCookie(result.token, isSecure(req)),
  })
}

/** 管理员账号管理：仅 admin 会话可用，避免 CLI 与运行中的网关同时改 users.json */
async function handleAdmin(req, res, url, user) {
  if (user.role !== 'admin') {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } })
    return
  }
  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, users: listUsers() })
    return
  }
  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    let body
    try { body = JSON.parse((await readBody(req, MAX_AUTH_BODY)).toString('utf8') || '{}') }
    catch { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST' } }); return }
    try {
      switch (body?.action) {
        case 'create':
          createUser(body.username, body.password, body.role === 'admin' ? 'admin' : 'user', body.quota)
          break
        case 'passwd':
          setPassword(body.username, body.password)
          break
        case 'disable':
        case 'enable':
          setDisabled(body.username, body.action === 'disable')
          break
        case 'quota':
          setQuota(body.username, body.quota)
          break
        default:
          sendJson(res, 400, { ok: false, error: { code: 'UNKNOWN_ACTION' } })
          return
      }
      sendJson(res, 200, { ok: true, users: listUsers() })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: error?.message ?? 'ADMIN_FAILED' } })
    }
    return
  }
  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } })
}

function proxy(req, res, { port, userId, bodyBuffer, maxUpload, release }) {
  const headers = { ...req.headers }
  // 会话 cookie 不出网关；所有客户端自报身份/内部凭据的头全部丢弃后重新注入
  delete headers.cookie
  delete headers['x-web-user']
  delete headers['x-xst-user']
  delete headers['x-xst-token']
  delete headers['x-xst-role']
  delete headers['x-xst-max-upload']
  delete headers['x-forwarded-proto']
  headers.host = `127.0.0.1:${port}`
  headers['x-xst-user'] = userId
  headers['x-xst-token'] = INTERNAL_TOKEN
  if (maxUpload) headers['x-xst-max-upload'] = String(maxUpload)
  if (bodyBuffer) headers['content-length'] = String(Buffer.byteLength(bodyBuffer))

  const upstream = http.request({
    host: '127.0.0.1', port, path: req.url, method: req.method, headers,
  }, upstreamRes => {
    const outHeaders = { ...upstreamRes.headers }
    delete outHeaders.connection
    delete outHeaders['transfer-encoding']
    delete outHeaders['keep-alive']
    res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
    upstreamRes.pipe(res)
    upstreamRes.on('end', release)
    upstreamRes.on('close', release)
  })
  upstream.on('error', error => {
    release()
    console.error('[web] 租户进程连接失败:', error)
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: { code: 'TENANT_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' } })
    } else {
      res.end()
    }
  })
  if (bodyBuffer) upstream.end(bodyBuffer)
  else req.pipe(upstream)
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    const detailed = Boolean(authenticate(req))
    sendJson(res, 200, {
      status: 'ok',
      staticReady: staticHost.available,
      ...(detailed ? {
        tenants: pool.stats().tenants,
        tenantRoot: pool.tenantBase,
        quota: quota.stats(),
        accounts: authStats().users,
      } : {}),
    })
    return
  }
  if (url.pathname === '/api/auth/status') {
    const user = authenticate(req)
    sendJson(res, 200, { ok: true, authenticated: Boolean(user), user })
    return
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    await handleLogin(req, res)
    return
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    logout(req)
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(isSecure(req)) })
    return
  }

  const user = authenticate(req)
  if (!user) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } })
    return
  }
  if (url.pathname === '/api/quota') {
    sendJson(res, 200, { ok: true, usage: quota.usage(user.id, user.quota) })
    return
  }
  if (url.pathname.startsWith('/api/admin/')) {
    await handleAdmin(req, res, url, user)
    return
  }
  let bodyBuffer = null
  let channel = ''
  let maxUpload = 0
  const activeQuota = user.quota ?? {}
  try {
    if (url.pathname === '/api/rpc') {
      bodyBuffer = await readBody(req, MAX_RPC_BODY)
      try { channel = String(JSON.parse(bodyBuffer.toString('utf8')).channel ?? '') }
      catch { sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON' } }); return }
    } else if (url.pathname === '/api/upload/stream') {
      const size = Number(req.headers['content-length'] ?? 0)
      quota.chargeUpload(user.id, activeQuota, size)
      maxUpload = Math.max(1, Number(activeQuota.maxUploadBytes ?? 50 * 1024 * 1024))
    }
  } catch (error) {
    const status = error instanceof QuotaError ? error.status : 400
    sendJson(res, status, { ok: false, error: { code: error.code ?? 'BAD_REQUEST', message: error.message } })
    return
  }

  let lease
  try {
    // SSE 是长连接，不能占住并发闸门或用户串行链，否则会卡死同账号的后续请求
    lease = url.pathname === '/api/events'
      ? { release: () => {} }
      : await quota.acquire(user.id, { channel, quota: activeQuota })
  } catch (error) {
    const status = error instanceof QuotaError ? error.status : 503
    sendJson(res, status, { ok: false, error: { code: error.code ?? 'QUEUE_ERROR', message: error.message } })
    return
  }

  let port
  try {
    port = await pool.get(user.id)
  } catch (error) {
    console.error('[web] 租户进程启动失败:', error)
    lease.release()
    sendJson(res, 503, { ok: false, error: { code: 'TENANT_START_FAILED', message: '工作区暂时不可用，请稍后重试' } })
    return
  }

  pool.begin(user.id)
  let released = false
  const release = () => {
    if (released) return
    released = true
    lease.release()
    pool.end(user.id)
  }
  res.on('finish', release)
  res.on('close', release)
  proxy(req, res, { port, userId: user.id, bodyBuffer, maxUpload, release })
}

const server = http.createServer((req, res) => {
  const nonce = randomBytes(16).toString('base64url')
  for (const [key, value] of Object.entries(securityHeaders({ secure: isSecure(req), nonce }))) {
    res.setHeader(key, value)
  }
  const url = new URL(req.url ?? '/', PUBLIC_ORIGIN)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
    res.end()
    return
  }
  // 所有状态变更请求统一校验来源；SameSite=Strict 之外再加一道显式防线
  if (!csrfOk(req)) {
    sendJson(res, 403, { ok: false, error: { code: 'CSRF_REJECTED', message: '请求来源不被允许' } })
    return
  }
  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url).catch(error => {
      console.error('[web] 请求处理失败:', error)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'GATEWAY_ERROR', message: '服务内部错误' } })
      }
    })
    return
  }
  staticHost.serve(req, res, url, nonce)
})

server.listen(PORT, HOST, () => {
  console.log(`[web] 网关已启动: http://${HOST}:${PORT}`)
  console.log(`[web] 数据根: ${DATA_ROOT}`)
  console.log(`[web] 租户根: ${pool.tenantBase}`)
  const sampleProject = path.join(pool.tenantBase, 'u_00000000000000000000', 'projects', '示例作品名称')
  if (sampleProject.length > 80) {
    console.warn('[web] ⚠️ 租户根路径过长，Windows 上新建作品会被原项目的 85 字符路径闸门拒绝；请设置 XST_TENANT_ROOT_BASE 指向短目录')
  }
  console.log(`[web] 静态产物: ${STATIC_ROOT} (${staticHost.available ? '就绪' : '未构建'})`)
  console.log(`[web] PUBLIC_ORIGIN=${PUBLIC_ORIGIN} NODE_ENV=${process.env.NODE_ENV ?? 'development'}`)
  if (isProduction && new URL(PUBLIC_ORIGIN).protocol !== 'https:') {
    console.warn('[web] ⚠️ 生产环境 PUBLIC_ORIGIN 应为 https://，否则 Cookie 的 Secure 标记不会生效')
  }
})

function shutdown() {
  pool.shutdown()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5_000).unref?.()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
