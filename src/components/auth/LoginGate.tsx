import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useLocaleStore } from '../../stores/locale-store'

interface AuthUser {
  id: string
  username: string
  role: string
  quota?: Record<string, number>
}

type GateState = 'checking' | 'guest' | 'ready'

/**
 * 网页版登录门禁。
 *
 * 会话是 HttpOnly Cookie，前端不保存任何凭据；只通过 /api/auth/status
 * 查询登录态。任何接口返回 401 时 ipc-client.web.ts 会广播
 * xst:unauthorized，这里切回登录页并卸载工作区，避免旧账号数据残留在内存里。
 */
export default function LoginGate({ children }: { children: ReactNode }) {
  const text = useLocaleStore(s => s.text)
  const [state, setState] = useState<GateState>('checking')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/status', { credentials: 'include' })
      const body = await response.json() as { authenticated?: boolean; user?: AuthUser }
      setUser(body.user ?? null)
      setState(body.authenticated && body.user ? 'ready' : 'guest')
    } catch {
      setUser(null)
      setState('guest')
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      setPassword('')
      setState('guest')
    }
    window.addEventListener('xst:unauthorized', onUnauthorized)
    return () => window.removeEventListener('xst:unauthorized', onUnauthorized)
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) {
        // 不把后端原始错误文案直接展示给页面，统一成本地化提示。
        setError(text('账号或口令不正确，请重试', 'Incorrect username or password'))
        setPassword('')
        return
      }
      setPassword('')
      await refresh()
    } catch {
      setError(text('无法连接服务，请稍后重试', 'Cannot reach the server, please try again'))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined)
    window.location.reload()
  }

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--nx-login-bg)] text-[13px] tracking-wide text-[var(--nx-login-muted)]">
        {text('正在检查登录状态…', 'Checking your session…')}
      </div>
    )
  }

  if (state === 'guest') {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[var(--nx-login-bg)] px-4 text-[var(--nx-login-text)]"
        style={{ backgroundImage: 'radial-gradient(70% 55% at 50% -12%, var(--nx-login-glow), transparent 70%)' }}
      >
        <form onSubmit={submit} className="w-full max-w-[380px] space-y-6 rounded-xl border border-[var(--nx-login-border)] bg-[var(--nx-login-panel)] px-8 py-9 shadow-2xl">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--nx-login-accent)] text-[15px] font-semibold text-[var(--nx-login-accent-ink)]">{text('书', 'P')}</span>
              <div>
                <div className="text-[15px] font-semibold tracking-[-.02em]">{text('小书童', 'Pagekin')}</div>
                <div className="text-[10px] uppercase tracking-[.22em] text-[var(--nx-login-muted)]">Northstar</div>
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="text-[22px] font-semibold tracking-[-.035em]">{text('进入写作空间', 'Enter your workspace')}</h1>
              <p className="text-[12px] leading-relaxed text-[var(--nx-login-muted)]">{text('登录后继续你的设定、大纲与正文。', 'Sign in to continue with your setup, outline and manuscript.')}</p>
            </div>
          </div>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-[12px] text-[var(--nx-login-muted)]">
              <span>{text('账号', 'Username')}</span>
              <input
                className="w-full rounded-lg border border-[var(--nx-login-border)] bg-[var(--nx-login-input)] px-3 py-2.5 text-[13px] text-[var(--nx-login-text)] outline-none transition-colors placeholder:text-[var(--nx-login-muted)] focus:border-[var(--nx-login-accent)]"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="block space-y-1.5 text-[12px] text-[var(--nx-login-muted)]">
              <span>{text('口令', 'Password')}</span>
              <input
                className="w-full rounded-lg border border-[var(--nx-login-border)] bg-[var(--nx-login-input)] px-3 py-2.5 text-[13px] text-[var(--nx-login-text)] outline-none transition-colors placeholder:text-[var(--nx-login-muted)] focus:border-[var(--nx-login-accent)]"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </div>
          {error && <p role="alert" className="text-[12px] text-[var(--nx-login-danger)]">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-[var(--nx-login-accent)] px-3 py-2.5 text-[13px] font-semibold text-[var(--nx-login-accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? text('登录中…', 'Signing in…') : text('登录', 'Sign in')}
          </button>
          <p className="text-[11px] leading-relaxed text-[var(--nx-login-muted)]">{text('账号由站点管理员创建，本页不提供注册。', 'Accounts are created by the site administrator. There is no sign-up on this page.')}</p>
        </form>
      </div>
    )
  }

  return (
    <>
      {children}
      <div className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded-lg border border-[var(--nx-login-border)] bg-[var(--nx-login-panel)] px-2 py-1 text-[11px] text-[var(--nx-login-text)] shadow-lg">
        <span className="text-[var(--nx-login-muted)]">{user?.username}</span>
        <button type="button" onClick={signOut} className="rounded px-2 py-0.5 transition-colors hover:bg-[var(--nx-login-input)]">{text('退出', 'Sign out')}</button>
      </div>
    </>
  )
}
