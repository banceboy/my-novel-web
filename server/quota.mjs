/**
 * P3 配额与任务队列。
 *
 * - 每账号每日 AI 调用次数、上传字节、累计存储字节（按用户持久化）
 * - 全局并发闸门 + 每用户串行链（controller 的进程级状态要求同账号请求不能交错）
 * - 排队有超时，超时返回 503，不会让连接无限挂起
 *
 * 真实计费/支付不在这里：这里只做「额度上限」的技术执行，
 * 账单与支付由运营侧另行接入，配额值由 auth-cli quota 命令设置。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class QuotaError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const AI_CHANNEL = /^(llm:|generation:|agent-generation:|review-revision:|character-(proposal|identity):|finalization-generation:|graph-generation:|import-generation:|editor-inline:|kb:backfill-vectors)/

function today() {
  return new Date().toISOString().slice(0, 10)
}

export class QuotaManager {
  constructor({
    dataRoot,
    maxGlobalConcurrency = Number(process.env.MAX_GLOBAL_CONCURRENCY ?? 8),
    queueTimeoutMs = Number(process.env.QUEUE_TIMEOUT_MS ?? 60_000),
  } = {}) {
    this.dir = path.join(path.resolve(dataRoot), 'quota')
    mkdirSync(this.dir, { recursive: true })
    this.maxGlobalConcurrency = Math.max(1, maxGlobalConcurrency)
    this.queueTimeoutMs = queueTimeoutMs
    this.active = 0
    this.globalWaiters = []
    this.userChains = new Map()
    this.state = new Map()
  }

  file(userId) {
    return path.join(this.dir, `${userId}.json`)
  }

  load(userId) {
    let record = this.state.get(userId)
    if (!record) {
      try {
        record = existsSync(this.file(userId))
          ? JSON.parse(readFileSync(this.file(userId), 'utf8')) : {}
      } catch { record = {} }
      this.state.set(userId, record)
    }
    if (record.date !== today()) {
      record.date = today()
      record.aiCalls = 0
      record.uploadedBytes = Number(record.uploadedBytes ?? 0)
    }
    return record
  }

  save(userId) {
    const record = this.state.get(userId)
    if (!record) return
    const file = this.file(userId)
    const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    renameSync(temp, file)
  }

  usage(userId, quota = {}) {
    const record = this.load(userId)
    return {
      date: record.date,
      aiCalls: record.aiCalls ?? 0,
      dailyAiCalls: quota.dailyAiCalls ?? 0,
      uploadedBytes: record.uploadedBytes ?? 0,
      maxStorageBytes: quota.maxStorageBytes ?? 0,
      maxUploadBytes: quota.maxUploadBytes ?? 0,
    }
  }

  /** 上传前预扣（保守：失败不退回，避免绕过配额） */
  chargeUpload(userId, quota, bytes) {
    const size = Number(bytes ?? 0)
    if (!Number.isFinite(size) || size < 0) throw new QuotaError(400, 'BAD_LENGTH', '上传长度非法')
    const maxUpload = Number(quota?.maxUploadBytes ?? 0)
    if (maxUpload > 0 && size > maxUpload) {
      throw new QuotaError(413, 'UPLOAD_TOO_LARGE', `单文件超过 ${maxUpload} 字节上限`)
    }
    const record = this.load(userId)
    const maxStorage = Number(quota?.maxStorageBytes ?? 0)
    if (maxStorage > 0 && (record.uploadedBytes ?? 0) + size > maxStorage) {
      throw new QuotaError(413, 'STORAGE_QUOTA_EXCEEDED', '账号存储空间已用尽')
    }
    record.uploadedBytes = (record.uploadedBytes ?? 0) + size
    this.save(userId)
  }

  checkAi(userId, quota, channel) {
    if (!AI_CHANNEL.test(channel)) return
    const record = this.load(userId)
    const limit = Number(quota?.dailyAiCalls ?? 0)
    if (limit > 0 && (record.aiCalls ?? 0) >= limit) {
      throw new QuotaError(429, 'AI_QUOTA_EXCEEDED', '今日 AI 调用额度已用尽')
    }
    record.aiCalls = (record.aiCalls ?? 0) + 1
    this.save(userId)
  }

  async withTimeout(promise, message) {
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new QuotaError(503, 'QUEUE_TIMEOUT', message)), this.queueTimeoutMs)
      timer.unref?.()
    })
    try { return await Promise.race([promise, timeout]) }
    finally { clearTimeout(timer) }
  }

  async acquire(userId, { channel = '', quota = {} } = {}) {
    this.checkAi(userId, quota, channel)
    let releaseGlobal = null
    if (this.active >= this.maxGlobalConcurrency) {
      await this.withTimeout(new Promise(resolve => this.globalWaiters.push(resolve)), '全局任务队列繁忙，请稍后重试')
    }
    this.active += 1
    releaseGlobal = () => {
      this.active -= 1
      const next = this.globalWaiters.shift()
      if (next) next()
    }

    const previous = this.userChains.get(userId) ?? Promise.resolve()
    let releaseUser = null
    const gate = new Promise(resolve => { releaseUser = resolve })
    const chain = previous.then(() => gate)
    this.userChains.set(userId, chain)
    try {
      await this.withTimeout(previous, '该账号有任务正在执行，排队超时')
    } catch (error) {
      releaseGlobal()
      releaseUser()
      throw error
    }

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        releaseUser()
        releaseGlobal()
        if (this.userChains.get(userId) === chain) this.userChains.delete(userId)
      },
    }
  }

  stats() {
    return { active: this.active, queued: this.globalWaiters.length, userQueues: this.userChains.size }
  }
}
