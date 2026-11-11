/**
 * 网页版 RPC 客户端 —— 公开 API 与 ipc-client.ts 完全一致。
 *
 * 接线方式：vite.web.config.ts 在 transform 阶段把源码里
 * `services/ipc-client` 的相对 import 改写成本文件。
 *
 * 与桌面版的差异：
 * - invoke() → POST /api/rpc，body 为 { channel, args, projectSession? }
 * - on/once() → SSE /api/events（会话 Cookie 自动携带，服务端按账号定向）
 * - 文件选择 → 浏览器原生 input + 流式 /api/upload/stream
 * - 导出 → RPC 响应带回本次产出的 exportTokens，按 token 精确下载
 * - send() → 不等待响应的 POST
 * - zoom 系列 → 网页版 no-op
 *
 * 鉴权：完全依赖 HttpOnly 会话 Cookie，前端不持有也不上报任何用户标识。
 * 任何 401 都广播 xst:unauthorized，由 LoginGate 切回登录页。
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

function webHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new Event('xst:unauthorized'))
}

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
  // 会话 Cookie 由浏览器自动携带；不再用可伪造的 query 参数标识用户
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
  stream.onerror = () => {
    // 会话失效时 EventSource 会不断重连；主动检查一次登录状态
    void fetch('/api/auth/status', { credentials: 'include' }).then(response => {
      if (response.status === 401) notifyUnauthorized()
    }).catch(() => undefined)
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

/** 文件选择通道 → 选择器规格；覆盖全部会调用 showOpenDialog(openFile) 的入口 */
type PickerSpec = { multiple: boolean; accept?: string; directory?: boolean; max: number }
const FILE_PICKER_CHANNELS = new Map<string, PickerSpec>([
  ['dialog:select-novel-files', { multiple: true, accept: '.txt,.md,.text,.epub', max: 20 }],
  ['dialog:select-knowledge-files', { multiple: true, accept: '.txt,.md,.markdown', max: 20 }],
  ['dialog:select-project-archive', { multiple: false, accept: '.ainovel', max: 1 }],
  ['character-avatar:choose', { multiple: false, accept: '.png,.jpg,.jpeg,.webp', max: 1 }],
  ['dialog:select-knowledge-folder', { multiple: true, directory: true, max: 100 }],
  ['skills:pick-local', { multiple: false, accept: '.md,.markdown', max: 1 }],
])

function pickerSpecFor(channel: string, args: unknown[]): PickerSpec | undefined {
  if (channel === 'skills:pick-local' && args[0] === 'folder') {
    return { multiple: true, directory: true, max: 100 }
  }
  return FILE_PICKER_CHANNELS.get(channel)
}

function pickFiles(spec: PickerSpec): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = spec.multiple
    if (spec.directory) {
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    } else if (spec.accept) {
      input.accept = spec.accept
    }
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.onchange = () => finish(Array.from(input.files ?? []))
    input.click()
    // 部分浏览器不触发 cancel 事件，超时兜底避免 Promise 永远挂起
    setTimeout(() => finish([]), 5 * 60 * 1000)
  })
}

/** 逐文件流式上传，最后一个请求提交整批；不把文件内容读进 JS 内存 */
async function uploadPickedFiles(spec: PickerSpec, channel: string): Promise<boolean> {
  const picked = (await pickFiles(spec)).slice(0, spec.max)
  if (picked.length === 0) return false
  const batch = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `batch${Date.now()}${Math.random().toString(36).slice(2)}`
  const layout = spec.directory ? 'folder' : 'files'
  for (let index = 0; index < picked.length; index += 1) {
    const file = picked[index]
    const params = new URLSearchParams({
      batch,
      channel,
      layout,
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      final: index === picked.length - 1 ? '1' : '0',
    })
    const response = await fetch(`/api/upload/stream?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      credentials: 'include',
      body: file,
    })
    if (response.status === 401) notifyUnauthorized()
    if (!response.ok) return false
  }
  return true
}

function fileNameFromDisposition(value: string | null): string {
  if (!value) return ''
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)
  if (encoded) {
    try { return decodeURIComponent(encoded[1]) } catch { /* 落到普通 filename */ }
  }
  return /filename="?([^";]+)"?/iu.exec(value)?.[1] ?? ''
}

async function downloadByToken(token: string): Promise<void> {
  const response = await fetch(`/api/download?token=${encodeURIComponent(token)}`, {
    credentials: 'include',
  })
  if (response.status === 401) notifyUnauthorized()
  if (!response.ok) return
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileNameFromDisposition(response.headers.get('Content-Disposition')) || 'export'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** 只下载本次 RPC 实际产出的文件；多文件（分章导出）逐个下载并留出间隔 */
async function triggerDownloads(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try { await downloadByToken(token) } catch { /* 下载失败不阻断原调用结果 */ }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

interface RpcBody {
  ok?: boolean
  data?: unknown
  error?: { message?: string }
  exportTokens?: string[]
}

async function invokeWithSession<C extends InvokeChannel>(
  channel: C,
  args: AllInvokeChannels[C]['args'],
  context?: ProjectSessionContext,
): Promise<AllInvokeChannels[C]['return']> {
  const spec = pickerSpecFor(channel as string, args as unknown as unknown[])
  if (spec) {
    const uploaded = await uploadPickedFiles(spec, channel as string)
    if (!uploaded) return null as unknown as AllInvokeChannels[C]['return']
  }

  const envelope: Record<string, unknown> = { channel, args }
  if (isProjectScopedChannel(channel)) {
    const projectSession = context ?? getActiveProjectSessionContext()
    if (!projectSession) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
    envelope.projectSession = projectSession
  }

  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: webHeaders(),
    credentials: 'include',
    body: JSON.stringify(envelope),
  })
  if (response.status === 401) {
    notifyUnauthorized()
    throw new Error('UNAUTHORIZED')
  }
  const body = await response.json() as RpcBody
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message ?? `RPC ${channel} failed (${response.status})`)
  }
  if (Array.isArray(body.exportTokens) && body.exportTokens.length > 0) {
    void triggerDownloads(body.exportTokens)
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
      throw new Error(`Channel is not project-scoped: ${channel}`)
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
      headers: webHeaders(),
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
