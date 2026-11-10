/**
 * 服务端版「假 electron」。
 *
 * 由 electron-loader.mjs 把 `import ... from 'electron'` 重定向到这里，
 * 使 electron/controllers/* 的业务逻辑无需改动即可在纯 Node 环境注册。
 *
 * 已覆盖源码中实际出现的具名导入：
 * app / BrowserWindow / ipcMain / dialog / shell / safeStorage /
 * nativeImage / ipcRenderer / contextBridge / webFrame / webContents
 * （type-only 导入如 IpcMainInvokeEvent、WebContents 在运行时会被擦除）
 *
 * 网页版上下文：每次 HTTP 请求用 AsyncLocalStorage 携带 userId，
 * 让事件广播、上传队列、目录意图、导出记录都按用户隔离。
 * 没有上下文时（后台任务 / 全局广播）userId 为 null，事件投递给所有连接。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const handlers = new Map()
const bus = new EventEmitter()
bus.setMaxListeners(0)

const requestStore = new AsyncLocalStorage()

/** 把一个 HTTP 请求放进带 userId 的异步上下文；handler 内所有 shim 行为都能拿到它 */
export function runWithRequest(context, fn) {
  return requestStore.run({
    userId: context?.userId ?? null,
    channel: context?.channel ?? null,
    allowAutoDirectory: true,
  }, fn)
}
/** 必须靠浏览器上传的通道：队列为空时应返回「用户取消」，不能塞服务端目录 */
export function setAllowAutoDirectory(value) {
  const store = requestStore.getStore()
  if (store) store.allowAutoDirectory = Boolean(value)
}
function keyOf(userId) {
  return userId ?? 'anonymous'
}
export function currentUserId() {
  return requestStore.getStore()?.userId ?? null
}
export function currentChannel() {
  return requestStore.getStore()?.channel ?? null
}

export function getHandlers() {
  return handlers
}

export function onBroadcast(listener) {
  bus.on('push', listener)
}

/** userId=null 表示全局广播（例如后台 update:state），否则只投递给同名用户 */
export function broadcast(channel, payload, userId = currentUserId()) {
  bus.emit('push', { channel, payload, userId })
}

export const ipcMain = {
  handle(channel, handler) {
    if (handlers.has(channel)) {
      throw new Error(`[electron-shim] 重复注册通道: ${channel}`)
    }
    handlers.set(channel, handler)
  },
  handleOnce(channel, handler) {
    handlers.set(channel, (...args) => {
      handlers.delete(channel)
      return handler(...args)
    })
  },
  removeHandler(channel) {
    handlers.delete(channel)
  },
  removeAllListeners(channel) {
    if (channel) handlers.delete(channel)
    else handlers.clear()
  },
}

function makeWebContents(userId = currentUserId()) {
  return {
    id: 1,
    _webUserId: userId,
    isDestroyed: () => false,
    send(channel, ...payload) {
      broadcast(channel, payload.length <= 1 ? payload[0] : payload, userId)
    },
  }
}

function makeWindow(userId = currentUserId()) {
  return {
    webContents: makeWebContents(userId),
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    focus() {},
    close() {},
    hide() {},
    show() {},
    on() {},
    loadURL: async () => {},
    loadFile: async () => {},
  }
}

export const BrowserWindow = {
  getAllWindows: () => [makeWindow()],
  getFocusedWindow: () => makeWindow(),
  fromWebContents: (sender) => makeWindow(sender?._webUserId ?? currentUserId()),
  fromId: () => makeWindow(),
}

export const webContents = {
  getAllWebContents: () => [makeWebContents()],
  fromId: () => makeWebContents(),
}

function dataRoot() {
  return process.env.DATA_ROOT ?? './data'
}

export const app = {
  getPath(name) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
    const table = {
      userData: path.resolve(dataRoot(), 'user-data'),
      appData: dataRoot(),
      home,
      temp: process.env.TEMP ?? process.env.TMP ?? '/tmp',
      desktop: dataRoot(),
      documents: dataRoot(),
      downloads: dataRoot(),
      logs: dataRoot(),
      exe: process.argv[0],
    }
    return table[name] ?? dataRoot()
  },
  getAppPath: () => process.cwd(),
  getVersion: () => process.env.APP_VERSION ?? '0.1.0',
  getName: () => 'xiaoshutong',
  getLocale: () => 'zh-CN',
  isReady: () => true,
  whenReady: async () => undefined,
  on() {},
  once() {},
  off() {},
  quit() {},
  exit() {},
}

/** 网页版数据目录：作品 / 导出 / 上传，全在 DATA_ROOT 下，不需要用户挑本机文件夹 */
function webDir(name) {
  const root = path.resolve(dataRoot(), name)
  mkdirSync(root, { recursive: true })
  return root
}

export function webPaths() {
  return { projects: webDir('projects'), exports: webDir('exports'), uploads: webDir('uploads') }
}

/** 目录意图 → 服务端目录。intent 由 server/index.mjs 按通道名精确设定 */
const DIRECTORY_TARGETS = {
  export: 'exports',
  project: 'projects',
  legacy: 'projects',
  restore: 'projects',
  knowledge: 'projects',
}

/** 浏览器上传的路径按「用户 + 通道」排队，避免一次上传被别的入口误消费 */
const fileQueueByUser = new Map()
const purposeByUser = new Map()

export function queueSelectedFiles(paths, userId = currentUserId(), channel = null) {
  const key = keyOf(userId)
  let byChannel = fileQueueByUser.get(key)
  if (!byChannel) {
    byChannel = new Map()
    fileQueueByUser.set(key, byChannel)
  }
  const bucket = channel ?? '*'
  const list = byChannel.get(bucket) ?? []
  list.push(...paths)
  byChannel.set(bucket, list)
}
export function pendingFileCount(userId = currentUserId()) {
  const byChannel = fileQueueByUser.get(keyOf(userId))
  if (!byChannel) return 0
  return [...byChannel.values()].reduce((sum, list) => sum + list.length, 0)
}
export function takeSelectedFiles(userId = currentUserId(), channel = currentChannel()) {
  const byChannel = fileQueueByUser.get(keyOf(userId))
  if (!byChannel) return []
  const exact = channel && byChannel.get(channel)
  if (exact?.length) {
    byChannel.delete(channel)
    return exact
  }
  // 兼容未提供 channel 的直连调用（例如回归脚本）
  const fallback = byChannel.get('*')
  if (fallback?.length) {
    byChannel.delete('*')
    return fallback
  }
  return []
}

export function setDirectoryPurpose(purpose, userId = currentUserId()) {
  purposeByUser.set(keyOf(userId), { purpose: String(purpose ?? ''), at: Date.now() })
}
export function takeDirectoryPurpose(userId = currentUserId()) {
  const key = keyOf(userId)
  const entry = purposeByUser.get(key)
  purposeByUser.delete(key)
  // 意图只在声明后 10 秒内有效，避免一次导出操作污染后续的新建作品目录
  if (!entry || Date.now() - entry.at > 10_000) return null
  return entry.purpose
}

/** 导出文件按 token 登记，下载必须持 token + 同用户，杜绝「取最新」串扰 */
const exportRecords = new Map()

export function registerExport(filePath, userId = currentUserId()) {
  const token = randomUUID()
  const record = {
    token,
    filePath,
    userId: keyOf(userId),
    name: path.basename(filePath).replace(/^[0-9a-f-]{36}-/iu, ''),
    createdAt: Date.now(),
  }
  exportRecords.set(token, record)
  if (exportRecords.size > 500) {
    const oldest = [...exportRecords.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
    if (oldest) exportRecords.delete(oldest.token)
  }
  return token
}
export function getExportRecord(token, userId = currentUserId()) {
  const record = exportRecords.get(String(token ?? ''))
  if (!record || record.userId !== keyOf(userId)) return null
  if (!existsSync(record.filePath) || !statSync(record.filePath).isFile()) return null
  return record
}
export function listExports(userId = currentUserId()) {
  return [...exportRecords.values()]
    .filter(record => record.userId === keyOf(userId) && existsSync(record.filePath))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(record => ({
      token: record.token,
      name: record.name,
      createdAt: record.createdAt,
      ready: statSync(record.filePath).isFile(),
    }))
}
export const dialog = {
  showOpenDialog: async (options = {}) => {
    const properties = Array.isArray(options?.properties) ? options.properties : []
    // 每次选择器调用都消费掉目录意图，避免残留污染后续通道
    const purpose = takeDirectoryPurpose()
    // 上传队列优先：既有单/多文件，也有 webkitdirectory 还原出来的整个文件夹
    const selected = takeSelectedFiles()
    if (selected.length) return { canceled: false, filePaths: selected }
    // 没有上传路径的目录类通道：按意图落到服务端目录。
    // 目录必须真实存在：ExternalFileGrantService.issueDirectory 会 realpathSync 校验。
    if (properties.includes('openDirectory')
        && requestStore.getStore()?.allowAutoDirectory !== false) {
      const target = DIRECTORY_TARGETS[purpose ?? 'project'] ?? 'projects'
      return { canceled: false, filePaths: [webPaths()[target]] }
    }
    return { canceled: true, filePaths: [] }
  },
  showOpenDialogSync: () => [],
  showSaveDialog: async (options = {}) => {
    const suggested = typeof options?.defaultPath === 'string'
      ? path.basename(options.defaultPath) : 'export.txt'
    const filePath = path.join(webPaths().exports, `${randomUUID()}-${suggested}`)
    return { canceled: false, filePath }
  },
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: () => {},
}

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: () => {},
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
  createFromBuffer: () => ({ isEmpty: () => true }),
}

export const ipcRenderer = {
  invoke: async () => {
    throw new Error('[electron-shim] 服务端没有渲染进程')
  },
  on() {},
  once() {},
  send() {},
  removeListener() {},
}

export const contextBridge = { exposeInMainWorld: () => {} }

export const webFrame = {
  setZoomLevel: () => {},
  setZoomFactor: () => {},
  getZoomLevel: () => 1,
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  nativeImage,
  ipcRenderer,
  contextBridge,
  webFrame,
  webContents,
}
