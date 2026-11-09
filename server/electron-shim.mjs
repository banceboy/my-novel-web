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
 * P2 阶段应把真实文件系统/窗口相关行为替换成服务端实现；
 * P3 阶段需把事件广播按 userId 隔离。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const handlers = new Map()
const bus = new EventEmitter()
bus.setMaxListeners(0)

export function getHandlers() {
  return handlers
}

export function onBroadcast(listener) {
  bus.on('push', listener)
}

export function broadcast(channel, payload) {
  bus.emit('push', { channel, payload })
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

function makeWebContents() {
  return {
    id: 1,
    isDestroyed: () => false,
    send(channel, ...payload) {
      broadcast(channel, payload.length <= 1 ? payload[0] : payload)
    },
  }
}

const fakeWindow = {
  webContents: makeWebContents(),
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

export const BrowserWindow = {
  getAllWindows: () => [fakeWindow],
  getFocusedWindow: () => fakeWindow,
  fromWebContents: () => fakeWindow,
  fromId: () => fakeWindow,
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

/** 浏览器上传的文件路径先入队，controller 调用 showOpenDialog 时再消费 */
const pendingSelectedFiles = []
let pendingDirectoryPurpose = null
let latestExportPath = null

export function webPaths() {
  return { projects: webDir('projects'), exports: webDir('exports'), uploads: webDir('uploads') }
}
export function queueSelectedFiles(paths) {
  pendingSelectedFiles.push(...paths)
}
export function takeSelectedFiles() {
  return pendingSelectedFiles.splice(0)
}
let pendingPurposeAt = 0
export function setDirectoryPurpose(purpose) {
  pendingDirectoryPurpose = purpose
  pendingPurposeAt = Date.now()
}
export function takeDirectoryPurpose() {
  const value = pendingDirectoryPurpose
  const fresh = Date.now() - pendingPurposeAt < 10_000
  pendingDirectoryPurpose = null
  // 意图只在声明后 10 秒内有效，避免一次导出操作污染后续的新建作品目录
  return fresh ? value : null
}
export function setLatestExport(filePath) {
  latestExportPath = filePath
}
export function getLatestExport() {
  if (latestExportPath && existsSync(latestExportPath)) return latestExportPath
  // 兜底：某些导出流程直接写目录、没走 showSaveDialog，取目录里最新的文件
  const root = webPaths().exports
  const newest = readdirSync(root)
    .map(name => ({ name, time: statSync(path.join(root, name)).mtimeMs }))
    .sort((left, right) => right.time - left.time)[0]
  return newest ? path.join(root, newest.name) : null
}

export const dialog = {
  showOpenDialog: async (options = {}) => {
    const properties = Array.isArray(options?.properties) ? options.properties : []
    // 目录选择：新建/打开作品 → projects；导出目标 → exports（由前端先声明意图）。
    // 目录必须真实存在：ExternalFileGrantService.issueDirectory 会 realpathSync 校验。
    if (properties.includes('openDirectory')) {
      const root = takeDirectoryPurpose() === 'export'
        ? webPaths().exports : webPaths().projects
      return { canceled: false, filePaths: [root] }
    }
    // 选文件：路径来自浏览器上传端点 /api/upload，按原流程返回给 controller。
    const selected = takeSelectedFiles()
    return selected.length
      ? { canceled: false, filePaths: selected }
      : { canceled: true, filePaths: [] }
  },
  showOpenDialogSync: () => [],
  showSaveDialog: async (options = {}) => {
    const suggested = typeof options?.defaultPath === 'string'
      ? path.basename(options.defaultPath) : 'export.txt'
    const filePath = path.join(webPaths().exports, `${randomUUID()}-${suggested}`)
    setLatestExport(filePath)
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
