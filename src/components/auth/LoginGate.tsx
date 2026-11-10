import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'

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
        const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
        setError(body.error?.message ?? '登录失败，请检查账号与口令')
        setPassword('')
        return
      }
      setPassword('')
      await refresh()
    } catch {
      setError('无法连接服务，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined)
    window.location.reload()
  }

  if (state === 'checking') {
    return <div className="flex min-h-screen items-center justify-center text-sm">正在检查登录状态…</div>
  }

  if (state === 'guest') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-neutral-300 p-7 shadow-sm dark:border-neutral-700">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">小书童</h1>
            <p className="text-xs opacity-70">登录后进入你的写作空间</p>
          </div>
          <label className="block space-y-1 text-sm">
            <span>账号</span>
            <input
              className="w-full rounded border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-neutral-500 dark:border-neutral-600"
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>口令</span>
            <input
              className="w-full rounded border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-neutral-500 dark:border-neutral-600"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
          >
            {busy ? '登录中…' : '登录'}
          </button>
          <p className="text-xs opacity-60">账号由站点管理员创建，本页不提供注册。</p>
        </form>
      </div>
    )
  }

  return (
    <>
      {children}
      <div className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-800">
        <span className="opacity-70">{user?.username}</span>
        <button type="button" onClick={signOut} className="rounded px-2 py-0.5 hover:opacity-70">退出</button>
      </div>
    </>
  )
}
