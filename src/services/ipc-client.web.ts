/**
 * 网页版 RPC 客户端 —— 公开 API 与 ipc-client.ts 完全一致。
 *
 * 接线方式：在 vite.config.ts 中按构建目标把 `@/services/ipc-client`
 * 别名指向本文件（web 构建），桌面构建仍指向 ipc-client.ts。
 *
 * 与桌面版的差异：
 * - invoke() → POST /api/rpc，body 为 { channel, args, projectSession? }
 * - on/once() → SSE /api/events
 * - send() → 不等待响应的 POST
 * - zoom 系列 → 网页版 no-op
 *
 * 与桌面版保持一致：
 * - 项目会话（ProjectSessionContext）的注入规则完全相同
 *   （桌面版把它作为最后一个参数追加；本文件放进 envelope，
 *   由 server/index.mjs 还原成最后一个参数）
 */
import type {
  AllInvokeChannels,
  AllEventChannels,
  InvokeChannel,
  EventChannel,
  ProjectSessionContext,
} from '../shared/ipc-channels'
import { getActiveProjectSessionContext } from '../shared/project-session-context'

const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> }
const RPC_URL = meta.env?.VITE_RPC_URL ?? '/api/rpc'
const EVENTS_URL = meta.env?.VITE_EVENTS_URL ?? '/api/events'

type Listener = (data: unknown) => void

function isCapabilityOrAppDataChannel(channel: string): boolean {
  return channel.startsWith('fs:grant-')
    || channel.startsWith('dialog:select-')
    || channel.startsWith('prompt:')
    || channel.startsWith('skills:')
}

/** 必须与 ipc-client.ts 的 isProjectScopedChannel 保持同步 */
function isProjectScopedChannel(channel: string): boolean {
  if (isCapabilityOrAppDataChannel(channel)) return false
  return channel.startsWith('generation:')
    || channel.startsWith('character-proposal:')
    || channel.startsWith('character-identity:')
    || channel.startsWith('character-avatar:')
    || channel.startsWith('finalized-character:')
    || channel.startsWith('finalization-generation:')
    || channel.startsWith('graph-generation:')
    || channel.startsWith('legacy-roster:')
    || channel.startsWith('review-revision:')
    || channel.startsWith('agent-generation:')
    || channel.startsWith('import-generation:')
    || channel.startsWith('editor-inline:')
    || channel.startsWith('db:')
    || channel.startsWith('kb:')
    || channel.startsWith('chapter:')
    || channel.startsWith('fs:')
    || channel === 'project:save'
    || channel === 'project:update-config'
    || channel === 'project:delete'
    || channel === 'project:overview-current'
}

const listeners = new Map<string, Set<Listener>>()
let stream: EventSource | null = null

function ensureStream(): void {
  if (stream) return
  stream = new EventSource(EVENTS_URL, { withCredentials: true })
  stream.onmessage = (event: MessageEvent<string>) => {
    let envelope: { channel?: string; payload?: unknown }
    try {
      envelope = JSON.parse(event.data) as { channel?: string; payload?: unknown }
    } catch {
      return
    }
    if (!envelope.channel) return
    const bucket = listeners.get(envelope.channel)
    if (!bucket) return
    for (const fn of bucket) fn(envelope.payload)
  }
}

function subscribe(channel: string, fn: Listener): () => void {
  ensureStream()
  let bucket = listeners.get(channel)
  if (!bucket) {
    bucket = new Set<Listener>()
    listeners.set(channel, bucket)
  }
  bucket.add(fn)
  return () => {
    bucket?.delete(fn)
    if (bucket && bucket.size === 0) listeners.delete(channel)
  }
}

async function invokeWithSession<C extends InvokeChannel>(
  channel: C,
  args: AllInvokeChannels[C]['args'],
  context?: ProjectSessionContext,
): Promise<AllInvokeChannels[C]['return']> {
  const envelope: Record<string, unknown> = { channel, args }
  if (isProjectScopedChannel(channel)) {
    const projectSession = context ?? getActiveProjectSessionContext()
    if (!projectSession) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
    envelope.projectSession = projectSession
  }

  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(envelope),
  })
  const body = await response.json() as {
    ok?: boolean
    data?: unknown
    error?: { message?: string }
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message ?? `RPC ${channel} failed (${response.status})`)
  }
  return body.data as AllInvokeChannels[C]['return']
}

export const ipc = {
  invoke: async <C extends InvokeChannel>(
    channel: C,
    ...args: AllInvokeChannels[C]['args']
  ): Promise<AllInvokeChannels[C]['return']> => invokeWithSession(channel, args),

  invokeWithProjectSession: async <C extends InvokeChannel>(
    context: ProjectSessionContext,
    channel: C,
    ...args: AllInvokeChannels[C]['args']
  ): Promise<AllInvokeChannels[C]['return']> => {
    if (!isProjectScopedChannel(channel)) {
      throw new Error(`通道不属于项目会话范围：${channel}`)
    }
    return invokeWithSession(channel, args, context)
  },

  on: <C extends EventChannel>(
    channel: C,
    callback: (data: AllEventChannels[C]) => void,
  ): (() => void) => subscribe(channel, (data) => callback(data as AllEventChannels[C])),

  once: <C extends EventChannel>(
    channel: C,
    callback: (data: AllEventChannels[C]) => void,
  ): void => {
    let unsubscribe = () => {}
    unsubscribe = subscribe(channel, (data) => {
      unsubscribe()
      callback(data as AllEventChannels[C])
    })
  },

  send: (channel: string, ...args: unknown[]): void => {
    void fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ channel, args, fireAndForget: true }),
    }).catch(() => undefined)
  },

  get isElectron(): boolean {
    return false
  },

  setZoomLevel: (level: number): void => { void level },
  setZoomFactor: (factor: number): void => { void factor },
  getZoomLevel: (): number => 1,
}
