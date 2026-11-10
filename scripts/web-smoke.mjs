/**
 * 部署后一键自检（零依赖）：
 *   node scripts/web-smoke.mjs
 *   SMOKE_URL=https://novel.example.com SMOKE_USER=admin SMOKE_PASSWORD=... node scripts/web-smoke.mjs
 *
 * 不提供凭据时只检查公开端点与安全头；提供凭据时额外验证登录会话、
 * 租户 RPC、未授权拦截与 CSP。失败时进程退出码为 1。
 */
const BASE = (process.env.SMOKE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const USER = process.env.SMOKE_USER ?? ''
const PASSWORD = process.env.SMOKE_PASSWORD ?? ''
let pass = 0
let fail = 0

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`[PASS] ${name}`)
  } else {
    fail += 1
    console.log(`[FAIL] ${name} ${detail}`)
  }
}

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

function header(response, name) {
  return response.headers.get(name) ?? ''
}

const health = await call('/api/health')
ok('健康检查 200 且静态产物就绪',
  health.status === 200 && JSON.parse(health.text || '{}').staticReady === true,
  `${health.status} ${health.text.slice(0, 160)}`)

const index = await call('/')
ok('首页 200 且返回 HTML', index.status === 200 && /<html/i.test(index.text), `${index.status}`)
ok('安全响应头齐全',
  Boolean(header(index, 'content-security-policy'))
  && header(index, 'x-content-type-options') === 'nosniff'
  && header(index, 'x-frame-options') === 'DENY')
const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(header(index, 'content-security-policy'))?.[1] ?? ''
ok('内联脚本带 CSP nonce', Boolean(nonce) && index.text.includes(`nonce="${nonce}"`), nonce)

const guest = await call('/api/rpc', { method: 'POST', body: { channel: 'startup:get-state', args: [] } })
ok('未登录 RPC 被拒绝', guest.status === 401, `${guest.status}`)
const retired = await call('/api/download/latest')
ok('旧 /api/download/latest 端点未复活', retired.status === 401 || retired.status === 404, `${retired.status}`)

const crossOrigin = await call('/api/auth/logout', {
  method: 'POST', body: {}, headers: { Origin: 'https://evil.example' },
})
ok('跨站状态变更请求被拒绝', crossOrigin.status === 403, `${crossOrigin.status}`)

if (USER && PASSWORD) {
  const login = await call('/api/auth/login', {
    method: 'POST', body: { username: USER, password: PASSWORD },
  })
  const cookie = header(login, 'set-cookie').split(';')[0]
  ok('管理员登录成功', login.status === 200 && cookie.startsWith('xst_session='), `${login.status}`)
  ok('会话 Cookie 为 HttpOnly + SameSite=Strict',
    /HttpOnly/i.test(header(login, 'set-cookie'))
    && /SameSite=Strict/i.test(header(login, 'set-cookie')))

  if (cookie) {
    const rpc = await call('/api/rpc', {
      method: 'POST', cookie, body: { channel: 'startup:get-state', args: [] },
    })
    let ready = false
    try { ready = JSON.parse(rpc.text || '{}')?.data?.state === 'ready' } catch { /* 保留失败 */ }
    ok('租户 RPC 可用', rpc.status === 200 && ready, `${rpc.status} ${rpc.text.slice(0, 160)}`)

    const forged = await call('/api/rpc', {
      method: 'POST', cookie, headers: { 'X-Web-User': 'someone-else' },
      body: { channel: 'startup:get-state', args: [] },
    })
    ok('自报身份头不影响服务端身份', forged.status === 200, `${forged.status}`)

    const quota = await call('/api/quota', { cookie })
    ok('额度端点可用', quota.status === 200, `${quota.status}`)
    await call('/api/auth/logout', { method: 'POST', cookie, body: {} })
    const afterLogout = await call('/api/quota', { cookie })
    ok('登出后旧会话失效', afterLogout.status === 401, `${afterLogout.status}`)
  }
} else {
  console.log('[SKIP] 未设置 SMOKE_USER/SMOKE_PASSWORD，跳过登录态检查')
}

console.log(`\n[web-smoke] ${pass} PASS / ${fail} FAIL`)
// 不调用 process.exit()：让 undici 的 keep-alive 连接自然排空，避免 libuv 关闭期断言
process.exitCode = fail ? 1 : 0
