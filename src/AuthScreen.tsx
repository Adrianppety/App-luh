import { useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export async function authenticate(
  action: 'login' | 'register',
  username: string,
  password: string,
): Promise<Session> {
  if (!supabase) throw new Error('O Supabase ainda não foi configurado.')
  const { data, error } = await supabase.functions.invoke<{ session: Session }>('username-auth', {
    body: { action, username: username.trim().toLowerCase(), password },
  })
  if (error) {
    const context = error.context
    if (context instanceof Response) {
      const responseBody: unknown = await context.clone().json().catch(() => null)
      if (
        responseBody &&
        typeof responseBody === 'object' &&
        'error' in responseBody &&
        typeof responseBody.error === 'string'
      ) {
        throw new Error(responseBody.error)
      }
    }
    throw error
  }
  if (!data?.session?.access_token || !data.session.refresh_token) {
    throw new Error('A resposta de autenticação não contém uma sessão válida.')
  }
  const { data: sessionData, error: sessionError } = await supabase.auth.setSession(data.session)
  if (sessionError) throw sessionError
  if (!sessionData.session) throw new Error('Não foi possível iniciar a sessão.')
  return sessionData.session
}

export function AuthScreen({
  onAuthenticated,
  notice = '',
}: {
  onAuthenticated: (session: Session) => void
  notice?: string
}) {
  const [registering, setRegistering] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (registering && password !== confirmPassword) {
      setError('As senhas não coincidem.')
      return
    }

    setBusy(true)
    try {
      const session = await authenticate(registering ? 'register' : 'login', username, password)
      onAuthenticated(session)
    } catch (authError) {
      console.error('Não foi possível autenticar a conta.', authError)
      setError(authError instanceof Error ? authError.message : 'Não foi possível entrar na conta.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="w-full max-w-md rounded-[28px] border border-stone-200/70 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full border border-[#d6c4a5]">
            <img src="/LOGOTIPO_2-icon.png" alt="" className="h-12 w-12 object-contain" />
          </div>
          <h1 className="font-serif text-2xl text-stone-800">Luiza</h1>
          <p className="mt-2 text-sm text-stone-500">
            {registering ? 'Crie seu acesso para sincronizar seus dados.' : 'Entre para acessar seus dados sincronizados.'}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {notice && <p role="status" className="rounded-xl bg-[#fff7f1] px-3 py-2 text-sm text-[#9f4b12]">{notice}</p>}
          <label className="block text-sm font-medium text-stone-600">
            Nome de usuário
            <input
              autoComplete="username"
              minLength={3}
              maxLength={30}
              pattern="[a-zA-Z0-9._-]{3,30}"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2 w-full rounded-xl border border-stone-200 px-3.5 py-3 outline-none focus:border-[#ff6b12]"
              placeholder="Seu usuário"
            />
            <span className="mt-1 block text-xs font-normal text-stone-400">Use 3 a 30 letras, números, ponto, traço ou sublinhado.</span>
          </label>
          <label className="block text-sm font-medium text-stone-600">
            Senha
            <input
              type="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              minLength={8}
              maxLength={72}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-xl border border-stone-200 px-3.5 py-3 outline-none focus:border-[#ff6b12]"
              placeholder="Mínimo de 8 caracteres"
            />
          </label>
          {registering && (
            <label className="block text-sm font-medium text-stone-600">
              Confirmar senha
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={72}
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border border-stone-200 px-3.5 py-3 outline-none focus:border-[#ff6b12]"
              />
            </label>
          )}
          {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button disabled={busy} className="button-primary w-full rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-60">
            {busy ? 'Aguarde...' : registering ? 'Criar conta' : 'Entrar'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setRegistering((value) => !value)
            setError('')
          }}
          className="button-link mt-5 w-full text-center text-sm font-semibold"
        >
          {registering ? 'Já tenho uma conta' : 'Criar uma conta'}
        </button>
        <p className="mt-5 text-center text-xs leading-relaxed text-stone-400">
          O usuário não usa e-mail. Guarde sua senha: a recuperação deve ser feita pelo painel do Supabase.
        </p>
      </section>
    </main>
  )
}
