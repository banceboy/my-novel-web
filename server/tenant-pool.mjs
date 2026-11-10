/**
 * 租户进程池：一个账号一个 Node 进程，进程内复用原 Electron controllers。
 *
 * 为什么必须进程隔离：electron/database.ts 的 projectDb / currentProjectPath、
 * app-data-locator.ts 的 VELA_HOME 等都是模块级单例，且全局数据定位器只允许
 * install 一次。单进程内无论怎么按请求换路径，这些内存状态都会跨账号串扰。
 * 每租户独立进程 = 独立的模块单例 + 独立 DATA_ROOT，是最彻底的隔离。
 *
 * 进程只监听 127.0.0.1 的随机端口，不对外暴露；网关鉴权后反向代理进来。
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export class TenantPool {
  constructor({
    dataRoot,
    maxTenants = Number(process.env.MAX_TENANTS ?? 8),
    idleMs = Number(process.env.TENANT_IDLE_MS ?? 15 * 60 * 1000),
    readyTimeoutMs = Number(process.env.TENANT_READY_TIMEOUT_MS ?? 60_000),
    internalToken = '',
  } = {}) {
    this.dataRoot = path.resolve(dataRoot ?? process.env.DATA_ROOT ?? './data')
    this.internalToken = internalToken
    // 原项目对 Windows 上的作品根目录有 85 字符上限（SQLite / LanceDB 派生路径）。
    // 把租户目录放在磁盘根的短路径下，避免嵌进很长的仓库路径导致新建作品直接失败。
    const shortDefault = path.join(path.parse(process.cwd()).root, 'xst-data')
    this.tenantBase = path.resolve(process.env.XST_TENANT_ROOT_BASE ?? shortDefault)
    mkdirSync(this.tenantBase, { recursive: true })
    this.maxTenants = Math.max(1, maxTenants)
    this.idleMs = idleMs
    this.readyTimeoutMs = readyTimeoutMs
    this.entries = new Map()
    this.timer = setInterval(() => this.sweep(), 60_000)
    this.timer.unref?.()
  }

  tenantRoot(userId) {
    if (!/^u_[a-f0-9]{20}$/.test(userId)) throw new Error('TENANT_ID_INVALID')
    return path.join(this.tenantBase, userId)
  }

  async get(userId) {
    const existing = this.entries.get(userId)
    if (existing?.port) {
      existing.lastUsed = Date.now()
      return existing.port
    }
    if (existing?.promise) return existing.promise

    const entry = {
      userId,
      child: null,
      port: 0,
      promise: null,
      lastUsed: Date.now(),
      inflight: 0,
      waiters: [],
    }
    this.entries.set(userId, entry)
    entry.promise = new Promise((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
      const root = this.tenantRoot(userId)
      const child = fork(path.join(HERE, 'tenant-server.mjs'), [], {
        cwd: path.resolve(HERE, '..'),
        env: {
          ...process.env,
          DATA_ROOT: root,
          XST_TENANT_ID: userId,
          XST_TENANT_ROOT: root,
          XST_INTERNAL_TOKEN: this.internalToken,
          HOST: '127.0.0.1',
          PORT: '0',
        },
        execArgv: ['--import', pathToFileURL(path.join(HERE, 'register.mjs')).href],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      entry.child = child
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        this.fail(entry, new Error('TENANT_READY_TIMEOUT'))
      }, this.readyTimeoutMs)
      timer.unref?.()

      child.stdout?.on('data', chunk => process.stdout.write(`[tenant ${userId}] ${chunk}`))
      child.stderr?.on('data', chunk => process.stderr.write(`[tenant ${userId}] ${chunk}`))
      child.on('message', message => {
        if (message?.type !== 'ready' || settled) return
        settled = true
        clearTimeout(timer)
        entry.port = Number(message.port)
        for (const waiter of entry.waiters.splice(0)) waiter.resolve(entry.port)
        console.log(`[pool] 租户进程就绪 ${userId} port=${entry.port}`)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.entries.delete(userId)
        if (!settled) {
          settled = true
          this.fail(entry, new Error(`TENANT_EXIT_${code ?? signal}`))
        }
        console.log(`[pool] 租户进程退出 ${userId} code=${code} signal=${signal ?? ''}`)
      })
      child.on('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.fail(entry, error)
      })
    })
    this.evictIfNeeded(userId)
    return entry.promise
  }

  fail(entry, error) {
    this.entries.delete(entry.userId)
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error)
    entry.child?.kill('SIGKILL')
  }

  begin(userId) {
    const entry = this.entries.get(userId)
    if (entry) {
      entry.inflight += 1
      entry.lastUsed = Date.now()
    }
  }

  end(userId) {
    const entry = this.entries.get(userId)
    if (entry && entry.inflight > 0) entry.inflight -= 1
  }

  evictIfNeeded(currentUserId) {
    if (this.entries.size <= this.maxTenants) return
    const candidates = [...this.entries.values()]
      .filter(entry => entry.userId !== currentUserId && entry.inflight === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const entry of candidates.slice(0, this.entries.size - this.maxTenants)) {
      this.entries.delete(entry.userId)
      entry.child?.kill('SIGTERM')
    }
  }

  sweep() {
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (entry.inflight === 0 && now - entry.lastUsed > this.idleMs) {
        this.entries.delete(entry.userId)
        entry.child?.kill('SIGTERM')
        console.log(`[pool] 回收空闲租户 ${entry.userId}`)
      }
    }
  }

  stats() {
    return {
      tenants: this.entries.size,
      maxTenants: this.maxTenants,
      active: [...this.entries.values()].map(entry => ({
        userId: entry.userId,
        port: entry.port,
        inflight: entry.inflight,
        idleMs: Date.now() - entry.lastUsed,
      })),
    }
  }

  shutdown() {
    clearInterval(this.timer)
    for (const entry of this.entries.values()) entry.child?.kill('SIGTERM')
    this.entries.clear()
  }
}
