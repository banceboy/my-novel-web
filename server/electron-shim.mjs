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

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => [],
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
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
