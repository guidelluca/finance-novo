import { useEffect, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabase'
import { biometricLabel, isEnrolledHere, passkeySupported, signInWithPasskey } from '@/lib/passkeys'

export function LoginPage() {
  const { user, loading, signIn, signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [canPasskey, setCanPasskey] = useState(false)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  useEffect(() => setCanPasskey(passkeySupported()), [])

  const loginWithPasskey = async () => {
    setError(null)
    setPasskeyBusy(true)
    try {
      const err = await signInWithPasskey()
      if (err) setError(err)
    } finally {
      setPasskeyBusy(false)
    }
  }

  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted">
        Carregando…
      </div>
    )
  }
  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const fn = mode === 'login' ? signIn : signUp
      const { error: err } = await fn(email, password)
      if (err) setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-ink font-display text-2xl font-bold text-lime" aria-hidden>
          F
        </span>
        <p className="font-display text-2xl font-bold">Finance</p>
        <p className="max-w-xs text-sm text-muted">Todas as suas contas num lugar só, sem repetir nada, com o mês fechado certinho.</p>
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{mode === 'login' ? 'Entrar' : 'Criar conta'}</CardTitle>
          <CardDescription>
            {mode === 'login'
              ? 'Use seu e-mail e senha ou a biometria do aparelho.'
              : 'Escolha um e-mail e uma senha (mínimo 6 caracteres).'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canPasskey && mode === 'login' ? (
            <div className="space-y-2">
              <Button
                type="button"
                className="h-12 w-full text-base"
                disabled={passkeyBusy}
                onClick={() => void loginWithPasskey()}
              >
                <Fingerprint className="size-5" aria-hidden />
                {passkeyBusy ? 'Aguardando…' : `Entrar com ${biometricLabel()}`}
              </Button>
              <p className="text-center text-xs text-muted">
                {isEnrolledHere()
                  ? 'Use o Face ID / Touch ID deste aparelho.'
                  : 'Primeira vez? Entre com e-mail e senha abaixo e ative o acesso por biometria.'}
              </p>
              <div className="flex items-center gap-3 py-1 text-xs text-muted">
                <span className="h-px flex-1 bg-border" />ou<span className="h-px flex-1 bg-border" />
              </div>
            </div>
          ) : null}
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Cadastrar'}
            </Button>
            <button
              type="button"
              className="w-full text-center text-sm text-muted underline"
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
            >
              {mode === 'login' ? 'Novo por aqui? Criar conta' : 'Já tenho conta'}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
