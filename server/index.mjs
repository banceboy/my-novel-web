/**
 * P1 网页版 RPC 服务入口（零新增依赖，Node 原生 http）。
 *
 * 启动：
 *   node --import ./server/register.mjs server/index.mjs
 *
 * 端到端跑通还需：
 *   - 前端 vite.config.ts 把 @/services/ipc-client 别名指向 ipc-client.web.ts
 *   - Vite dev server 把 /api 代理到本服务（默认 127.0.0.1:8787）
 *   - P2 完成 Electron 依赖解耦（本服务已用 shim 覆盖大部分，剩余为文件路径/事件定向）
 *   - P3 实现真正的鉴权与多租户
 *
 * ⚠️ 当前 authenticate() 是占位实现，仅允许本机开发，禁止公网暴露。
 */
import http from 'node:http'
import { getHandlers, broadcast } from './electron-shim.mjs'
import { handleSse, sseClientCount } from './rpc/events.mjs'

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
const MAX_BODY = 8 * 1024 * 1024

let controllerStatus = 'not-loaded'

async function loadControllers() {
  try {
    const { prepareGlobalRuntime } = await import('./bootstrap.mjs')
    const runtime = await prepareGlobalRuntime()
    console.log(`[P1] 全局数据已就绪: ${runtime.root}`)
    const mod = await import('../electron/ipc-handlers.ts')
    const result = mod.registerIPCHandlers()
    if (result && typeof result.then === 'function') await result
    controllerStatus = `loaded (${getHandlers().size} channels)`
  } catch (error) {
    controllerStatus = `FAILED: ${error?.message ?? String(error)}`
    console.error('[P1] 原 controllers 加载失败。常见原因：')
    console.error('     1) Node 未能直接加载 TS（改用 `npm i -D tsx` 并以 --import tsx 启动）')
    console.error('     2) controllers 里存在 P2 尚未解耦的 Electron/文件系统行为')
    console.error('     3) TS 源码使用了 @/ 路径别名，Node 无法解析')
    console.error('     原始错误：', error)
  }
}

await loadControllers()

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
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('REQUEST_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('INVALID_JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** TODO(P3)：换成真实会话校验；当前固定为本地开发用户 */
function authenticate() {
  return { userId: 'dev-user' }
}

/** 模拟 IpcMainInvokeEvent，使 controller 里的 event.sender.send 可用 */
function makeEvent(userId) {
  return {
    sender: {
      id: 1,
      isDestroyed: () => false,
      send(channel, ...payload) {
        broadcast(channel, payload.length <= 1 ? payload[0] : payload)
      },
    },
    frameId: 1,
    processId: 0,
    userId,
  }
}

async function handleRpc(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
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

  const user = authenticate(req)
  const tail = Array.isArray(args) ? [...args] : []
  if (projectSession !== undefined) tail.push(projectSession)

  try {
    const data = await handler(makeEvent(user.userId), ...tail)
    sendJson(res, 200, { ok: true, data: data ?? null })
  } catch (error) {
    console.error(`[rpc] ${channel} 失败:`, error)
    sendJson(res, 500, {
      ok: false,
      error: { code: 'HANDLER_ERROR', message: error?.message ?? String(error) },
    })
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': url.origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Credentials': 'true',
    })
    res.end()
    return
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      status: 'ok',
      channels: getHandlers().size,
      controllers: controllerStatus,
      sseClients: sseClientCount(),
    })
    return
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    handleSse(req, res, authenticate(req).userId)
    return
  }

  if (url.pathname === '/api/rpc' && req.method === 'POST') {
    void handleRpc(req, res)
    return
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } })
})

server.listen(PORT, HOST, () => {
  console.log(`[P1] RPC 服务已启动: http://${HOST}:${PORT}`)
  console.log(`[P1] controllers: ${controllerStatus}`)
  console.log(`[P1] 健康检查: http://${HOST}:${PORT}/api/health`)
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('[P1] ⚠️ 鉴权尚未实现（P3），请勿将本服务暴露到公网')
  }
})
