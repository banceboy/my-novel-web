/**
 * 单租户 RPC 服务（由 TenantPool fork，只监听 127.0.0.1 的随机端口）。
 *
 * 关键：本进程只服务一个账号。electron/database.ts 的当前项目连接、
 * app-data-locator 的全局数据根等模块级单例因此天然不会跨账号串扰；
 * DATA_ROOT 在 fork 时指向 DATA_ROOT/tenants/<userId>。
 *
 * 鉴权由网关完成，这里只信任来自回环且带正确 X-XST-User 的代理请求；
 * 浏览器永远不会直接连到本端口。
 */
import http from 'node:http'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  getHandlers, broadcast, ipcMain, webPaths, queueSelectedFiles,
  setDirectoryPurpose, setAllowAutoDirectory, getExportRecord, listExports,
  registerExport, runWithRequest, pendingFileCount,
} from './electron-shim.mjs'
import { handleSse, sseClientCount } from './rpc/events.mjs'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT ?? 0)
const TENANT_ID = process.env.XST_TENANT_ID ?? ''
const INTERNAL_TOKEN = process.env.XST_INTERNAL_TOKEN ?? ''
const MAX_RPC_BODY = 32 * 1024 * 1024
const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024

if (!/^u_[a-f0-9]{20}$/.test(TENANT_ID)) {
  console.error('[tenant] XST_TENANT_ID 缺失或非法，拒绝启动')
  process.exit(1)
}

const DIRECTORY_INTENTS = {
  'dialog:select-export-directory': 'export',
  'dialog:select-folder': 'project',
  'dialog:select-legacy-project': 'legacy',
  'dialog:select-project-restore-target': 'restore',
}
const UPLOAD_CHANNELS = new Set([
  'dialog:select-novel-files',
  'dialog:select-knowledge-files',
  'dialog:select-knowledge-folder',
  'dialog:select-project-archive',
  'character-avatar:choose',
  'skills:pick-local',
])

function exportSnapshot() {
  const result = new Map()
  const walk = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) {
        const stat = statSync(full)
        result.set(full, `${stat.mtimeMs}:${stat.size}`)
      }
    }
  }
  walk(webPaths().exports, 0)
  return result
}

let controllerStatus = 'not-loaded'

async function loadControllers() {
  try {
    const { prepareGlobalRuntime } = await import('./bootstrap.mjs')
    const runtime = await prepareGlobalRuntime()
    console.log(`[tenant] 全局数据已就绪: ${runtime.root}`)
    const mod = await import('../electron/ipc-handlers.ts')
    const result = mod.registerIPCHandlers()
    if (result && typeof result.then === 'function') await result
    if (!getHandlers().has('startup:get-state')) {
      ipcMain.handle('startup:get-state', () => ({ state: 'ready', globalGeneration: 'web-p3' }))
    }
    if (!getHandlers().has('startup:appearance-ack')) {
      ipcMain.handle('startup:appearance-ack', () => true)
    }
    controllerStatus = `loaded (${getHandlers().size} channels)`
  } catch (error) {
    controllerStatus = `FAILED: ${error?.message ?? String(error)}`
    console.error('[tenant] controllers 加载失败:', error)
  }
}

await loadControllers()

/** 启动清理：上传批次保留 24 小时，导出文件保留 7 天，避免磁盘无限增长 */
function cleanupRuntime() {
  const { uploads, exports } = webPaths()
  const rules = [[uploads, 24 * 60 * 60 * 1000], [exports, 7 * 24 * 60 * 60 * 1000]]
  for (const [dir, ttl] of rules) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      try {
        if (Date.now() - statSync(full).mtimeMs > ttl) rmSync(full, { recursive: true, force: true })
      } catch { /* 文件正被占用时留到下次启动 */ }
    }
  }
}
cleanupRuntime()

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_RPC_BODY) {
        reject(new Error('REQUEST_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('INVALID_JSON')) }
    })
    req.on('error', reject)
  })
}

/** 只接受网关注入的身份；浏览器直达本端口（无 header 或非回环）一律 401 */
function tenantFrom(req) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const header = req.headers['x-xst-user']
  // 共享密钥由网关在 fork 时注入；本机其它进程即便猜到端口也无法冒充
  if (!loopback || header !== TENANT_ID) return null
  if (!INTERNAL_TOKEN || req.headers['x-xst-token'] !== INTERNAL_TOKEN) return null
  return { userId: TENANT_ID }
}

function makeEvent(userId) {
  return {
    sender: {
      id: 1,
      _webUserId: userId,
      isDestroyed: () => false,
      once: () => undefined,
      send(channel, ...payload) {
        broadcast(channel, payload.length <= 1 ? payload[0] : payload, userId)
      },
    },
    frameId: 1,
    processId: 0,
    userId,
  }
}

// 同一租户内的 RPC 必须串行：controller 持有「当前项目」等进程级状态
let rpcChain = Promise.resolve()
function enqueueRpc(job) {
  const result = rpcChain.then(job, job)
  rpcChain = result.catch(() => {})
  return result
}

async function handleRpc(req, res) {
  let body
  try { body = await readJson(req) }
  catch (error) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: error.message } })
    return
  }
  const { channel, args, projectSession } = body
  if (typeof channel !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 channel' } })
    return
  }
  const handler = getHandlers().get(channel)
  if (!handler) {
    sendJson(res, 404, {
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL', message: `未注册通道: ${channel}；已注册 ${getHandlers().size} 个` },
    })
    return
  }
  const tail = Array.isArray(args) ? [...args] : []
  if (projectSession !== undefined) tail.push(projectSession)

  await enqueueRpc(async () => {
    const before = exportSnapshot()
    try {
      const data = await runWithRequest({ userId: TENANT_ID, channel }, () => {
        if (UPLOAD_CHANNELS.has(channel)) setAllowAutoDirectory(false)
        const intent = DIRECTORY_INTENTS[channel]
        if (intent) setDirectoryPurpose(intent, TENANT_ID)
        return handler(makeEvent(TENANT_ID), ...tail)
      })
      const after = exportSnapshot()
      const exportTokens = []
      for (const [file, signature] of after) {
        if (before.get(file) !== signature) exportTokens.push(registerExport(file, TENANT_ID))
      }
      sendJson(res, 200, { ok: true, data: data ?? null, exportTokens })
    } catch (error) {
      console.error(`[rpc] ${channel} 失败:`, error)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'HANDLER_ERROR', message: error?.message ?? String(error) },
      })
    }
  })
}

/** 流式上传：一次请求一个文件，body 是原始字节，不再 base64 整个进内存 */
const uploadBatches = new Map()

function safePart(value, fallback) {
  return String(value ?? fallback)
    .replace(/[^\w.\-\u4e00-\u9fa5]/gu, '_').slice(0, 120) || fallback
}

function limitStream(maxBytes) {
  let total = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) callback(new Error('UPLOAD_TOO_LARGE'))
      else callback(null, chunk)
    },
  })
}

async function handleUploadStream(req, res, url) {
  for (const [key, bucket] of uploadBatches) {
    if (Date.now() - bucket.at > 30 * 60 * 1000) uploadBatches.delete(key)
  }
  const params = url.searchParams
  const batch = params.get('batch') ?? ''
  const channel = params.get('channel') ?? null
  const layout = params.get('layout') === 'folder' ? 'folder' : 'files'
  const final = params.get('final') === '1'
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(batch)) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_BATCH', message: '上传批次标识非法' } })
    return
  }
  const maxBytes = Number(req.headers['x-xst-max-upload']) || DEFAULT_MAX_UPLOAD
  const { uploads } = webPaths()
  const root = path.join(uploads, batch)
  mkdirSync(root, { recursive: true })

  let relative = String(params.get('relativePath') ?? params.get('name') ?? 'upload.txt')
    .split(/[\\/]/u)
    .filter(part => part && !/^\.+$/u.test(part))
    .map(part => safePart(part, 'part'))
  if (layout === 'folder' && relative.length > 1) relative = relative.slice(1)
  if (relative.length === 0) relative = ['upload.txt']
  const name = safePart(params.get('name') ?? 'upload.txt', 'upload.txt')
  const target = layout === 'folder'
    ? path.join(root, ...relative.slice(0, 8))
    : path.join(root, `${randomUUID()}-${name}`)
  // 双重防穿越：解析后的绝对路径必须仍在本次批次目录内
  if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) {
    sendJson(res, 400, { ok: false, error: { code: 'UNSAFE_UPLOAD_PATH' } })
    return
  }
  mkdirSync(path.dirname(target), { recursive: true })

  let written = 0
  try {
    await pipeline(req, limitStream(maxBytes), new Transform({
      transform(chunk, _encoding, callback) { written += chunk.length; callback(null, chunk) },
    }), createWriteStream(target, { flags: 'w' }))
  } catch (error) {
    try { unlinkSync(target) } catch { /* 可能尚未创建 */ }
    const tooLarge = error?.message === 'UPLOAD_TOO_LARGE'
    sendJson(res, tooLarge ? 413 : 500, {
      ok: false, error: { code: tooLarge ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_WRITE_FAILED', message: String(error?.message ?? error) },
    })
    return
  }

  const bucket = uploadBatches.get(batch) ?? { root, layout, channel, files: [], bytes: 0, at: Date.now() }
  bucket.files.push(target)
  bucket.bytes += written
  bucket.channel = channel ?? bucket.channel
  uploadBatches.set(batch, bucket)

  let queued = 0
  if (final) {
    const paths = bucket.layout === 'folder' ? [bucket.root] : bucket.files
    if (paths.length > 0) {
      queueSelectedFiles(paths, TENANT_ID, bucket.channel)
      queued = paths.length
    }
    uploadBatches.delete(batch)
  }
  sendJson(res, 200, { ok: true, bytes: written, files: bucket.files.length, queued })
}

function sendFile(res, filePath, name) {
  const data = readFileSync(filePath)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

/** 只接受 token：旧的 /api/download/latest 已下线，杜绝扫目录撞到他人文件 */
function handleDownload(res, url) {
  const record = getExportRecord(url.searchParams.get('token'), TENANT_ID)
  if (!record) {
    sendJson(res, 404, { ok: false, error: { code: 'EXPORT_NOT_FOUND', message: '导出文件不存在或已失效' } })
    return
  }
  sendFile(res, record.filePath, record.name)
}

function handleFilesState(res) {
  const exports = listExports(TENANT_ID)
  sendJson(res, 200, {
    ok: true,
    exports,
    pendingUploads: pendingFileCount(TENANT_ID),
    latestExportReady: exports.some(item => item.ready),
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  if (!tenantFrom(req)) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '仅允许经网关访问' } })
    return
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok', channels: getHandlers().size,
      controllers: controllerStatus, sseClients: sseClientCount(), tenant: TENANT_ID,
    })
    return
  }
  if (url.pathname === '/api/upload/stream' && req.method === 'POST') {
    void handleUploadStream(req, res, url)
    return
  }
  if (url.pathname === '/api/download' && req.method === 'GET') {
    handleDownload(res, url)
    return
  }
  if (url.pathname === '/api/files/state' && req.method === 'GET') {
    handleFilesState(res)
    return
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    handleSse(req, res, TENANT_ID)
    return
  }
  if (url.pathname === '/api/rpc' && req.method === 'POST') {
    void handleRpc(req, res)
    return
  }
  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } })
})

server.listen(PORT, HOST, () => {
  const address = server.address()
  console.log(`[tenant] ${TENANT_ID} 就绪: http://${HOST}:${address.port} / ${controllerStatus}`)
  process.send?.({ type: 'ready', port: address.port })
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5_000).unref?.()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('disconnect', shutdown)
