/**
 * 真实会话鉴权（零新增依赖）。
 *
 * - 用户库存 DATA_ROOT/auth/users.json，口令用 scrypt 加盐哈希，绝不明文保存
 * - 会话是服务端持有的不透明 token；落盘只存 sha256(token)，文件泄露也不能直接冒用
 * - Cookie: HttpOnly + SameSite=Strict + (HTTPS 时) Secure，前端 JS 读不到、也无法自报 userId
 *
 * 首次启动：
 * - 生产：必须设置 BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD，否则拒绝启动
 * - 开发：自动建 dev 账号并把随机口令打印到启动日志（不写入任何文件）
 * 日常管理用 `node server/auth-cli.mjs`，不暴露注册接口。
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const SESSION_COOKIE = 'xst_session'
export const DEFAULT_QUOTA = Object.freeze({
  dailyAiCalls: 200,
  maxUploadBytes: 50 * 1024 * 1024,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
})

const DATA_ROOT = path.resolve(process.env.DATA_ROOT ?? './data')
const AUTH_DIR = path.join(DATA_ROOT, 'auth')
const USERS_FILE = path.join(AUTH_DIR, 'users.json')
const SESSIONS_FILE = path.join(AUTH_DIR, 'sessions.json')
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS ?? 12)) * 60 * 60 * 1000
const MAX_FAILURES = 5
const LOCK_MS = 15 * 60 * 1000
const TOKEN_PATTERN = /^[a-f0-9]{64}$/

const users = new Map()
const sessions = new Map()
const failures = new Map()
let persistTimer = null

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch { /* Windows 不保证 POSIX 权限 */ }
  renameSync(temp, file)
}

function persistSessions() {
  try {
    writeJsonAtomic(SESSIONS_FILE, {
      version: 1,
      sessions: [...sessions.entries()].map(([tokenHash, session]) => ({ ...session, tokenHash })),
    })
  } catch (error) {
    console.error('[auth] 会话落盘失败:', error)
  }
}

/** 只用于滑动续期这类可丢失的更新；登录/登出必须同步落盘，避免重启即掉线 */
function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistSessions()
  }, 200)
  persistTimer.unref?.()
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function loadAuthStore() {
  mkdirSync(AUTH_DIR, { recursive: true })
  const storedUsers = readJson(USERS_FILE, { users: [] })
  for (const user of Array.isArray(storedUsers.users) ? storedUsers.users : []) {
    if (user && typeof user.id === 'string' && typeof user.username === 'string') users.set(user.id, user)
  }
  const storedSessions = readJson(SESSIONS_FILE, { sessions: [] })
  for (const session of Array.isArray(storedSessions.sessions) ? storedSessions.sessions : []) {
    if (session?.tokenHash && TOKEN_PATTERN.test(session.tokenHash) && session.userId && session.expiresAt > Date.now()) {
      sessions.set(session.tokenHash, { userId: session.userId, expiresAt: session.expiresAt })
    }
  }
}

export function createUser(username, password, role = 'user', quota = {}) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error('USERNAME_INVALID')
  if (typeof password !== 'string' || password.length < 10) throw new Error('PASSWORD_TOO_SHORT')
  if ([...users.values()].some(user => user.username === username)) throw new Error('USERNAME_TAKEN')
  const salt = randomBytes(16).toString('hex')
  const user = {
    id: `u_${createHash('sha256').update(username).update(randomBytes(8)).digest('hex').slice(0, 20)}`,
    username,
    salt,
    hash: passwordHash(password, salt),
    role: role === 'admin' ? 'admin' : 'user',
    quota: { ...DEFAULT_QUOTA, ...quota },
    disabled: false,
    createdAt: Date.now(),
  }
  users.set(user.id, user)
  writeJsonAtomic(USERS_FILE, { version: 1, users: [...users.values()] })
  return user
}

export function setPassword(username, password) {
  const user = [...users.values()].find(item => item.username === username)
  if (!user) throw new Error('USER_NOT_FOUND')
  if (typeof password !== 'string' || password.length < 10) throw new Error('PASSWORD_TOO_SHORT')
  user.salt = randomBytes(16).toString('hex')
  user.hash = passwordHash(password, user.salt)
  writeJsonAtomic(USERS_FILE, { version: 1, users: [...users.values()] })
  for (const [tokenHash, session] of sessions) {
    if (session.userId === user.id) sessions.delete(tokenHash)
  }
  persistSessions()
  return user
}

export function setDisabled(username, disabled) {
  const user = [...users.values()].find(item => item.username === username)
  if (!user) throw new Error('USER_NOT_FOUND')
  user.disabled = Boolean(disabled)
  writeJsonAtomic(USERS_FILE, { version: 1, users: [...users.values()] })
  for (const [tokenHash, session] of sessions) {
    if (session.userId === user.id) sessions.delete(tokenHash)
  }
  persistSessions()
  return user
}

export function setQuota(username, patch) {
  const user = [...users.values()].find(item => item.username === username)
  if (!user) throw new Error('USER_NOT_FOUND')
  const allowed = Object.keys(DEFAULT_QUOTA)
  const next = { ...DEFAULT_QUOTA, ...user.quota }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!allowed.includes(key) || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('QUOTA_INVALID')
    next[key] = Number(value)
  }
  user.quota = next
  writeJsonAtomic(USERS_FILE, { version: 1, users: [...users.values()] })
  return user
}

export function listUsers() {
  return [...users.values()].map(({ id, username, role, quota, disabled, createdAt }) =>
    ({ id, username, role, quota, disabled, createdAt }))
}

export function initAuth() {
  loadAuthStore()
  if (users.size > 0) return
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
  if (username && password) {
    createUser(username, password, 'admin')
    console.log(`[auth] 已从环境变量创建管理员账号: ${username}`)
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD 是生产环境必填项')
  } else {
    const generated = randomBytes(12).toString('base64url')
    createUser('dev', generated, 'admin')
    console.log(`[auth] 开发账号  username=dev  password=${generated}`)
    console.log('[auth] 该口令只在本次启动日志中出现；生产环境请用环境变量或 auth-cli 建号')
  }
}

function failureKey(req, username) {
  return `${req.socket?.remoteAddress ?? 'unknown'}|${username}`
}

export function login(req, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return { error: 'INVALID_CREDENTIALS' }
  const key = failureKey(req, username)
  const state = failures.get(key)
  if (state?.until > Date.now()) return { error: 'TOO_MANY_ATTEMPTS' }
  const user = [...users.values()].find(item => item.username === username)
  // 用户不存在也做一次 scrypt，避免按响应时间枚举账号
  const salt = user?.salt ?? '00000000000000000000000000000000'
  const candidate = passwordHash(password, salt)
  const valid = Boolean(user && !user.disabled && safeEqualHex(candidate, user.hash))
  if (!valid) {
    const next = state && state.until <= Date.now() ? { count: state.count + 1, until: 0 } : { count: (state?.count ?? 0) + 1, until: 0 }
    if (next.count >= MAX_FAILURES) {
      next.until = Date.now() + LOCK_MS
      failures.set(key, next)
      return { error: 'TOO_MANY_ATTEMPTS' }
    }
    failures.set(key, next)
    return { error: 'INVALID_CREDENTIALS' }
  }
  failures.delete(key)
  const token = randomBytes(32).toString('hex')
  const record = { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS }
  sessions.set(hashToken(token), record)
  persistSessions()
  return { token, user: publicUser(user) }
}

export function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, quota: user.quota ?? DEFAULT_QUOTA }
}

function parseCookies(header) {
  const result = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) {
      try { result[name] = decodeURIComponent(value) } catch { result[name] = value }
    }
  }
  return result
}

export function authenticate(req) {
  const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE]
  if (!token || !TOKEN_PATTERN.test(token)) return null
  const tokenHash = hashToken(token)
  const session = sessions.get(tokenHash)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash)
    persistSessions()
    return null
  }
  const user = users.get(session.userId)
  if (!user || user.disabled) return null
  if (session.expiresAt - Date.now() < SESSION_TTL_MS / 2) {
    session.expiresAt = Date.now() + SESSION_TTL_MS
    schedulePersist()
  }
  return publicUser(user)
}

export function logout(req) {
  const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE]
  if (token && TOKEN_PATTERN.test(token)) {
    sessions.delete(hashToken(token))
    persistSessions()
  }
}

export function sessionCookie(token, secure) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(secure) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function authStats() {
  return { users: users.size, sessions: sessions.size }
}
