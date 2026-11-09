/**
 * SSE 事件层：把 controller 里的 webContents.send / event.sender.send
 * 转成浏览器可接收的事件流。
 *
 * 注意：必须写成默认 message 事件（只发 data: 行），
 * 因为 ipc-client.web.ts 使用 EventSource.onmessage 接收。
 *
 * TODO(P3)：按 userId 定向投递，当前 P1 阶段为广播，仅限本机开发使用。
 */
import { onBroadcast } from '../electron-shim.mjs'

const clients = new Map()
let nextId = 1

function send(res, channel, payload) {
  res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
}

onBroadcast(({ channel, payload }) => {
  for (const client of clients.values()) {
    send(client.res, channel, payload)
  }
})

export function handleSse(req, res, userId = 'anonymous') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const id = nextId++
  clients.set(id, { res, userId })
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 20_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(id)
  })
}

export function sseClientCount() {
  return clients.size
}
