import { Fingerprint } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { appLockEnabled, biometricLabel, clearUnlocked, isUnlocked, passkeySupported, unlockWithPasskey } from '@/lib/passkeys'

/** Tempo fora do app que faz pedir a biometria de novo. */
const RELOCK_AFTER_MS = 3 * 60 * 1000

/**
 * Tela de bloqueio: ao abrir o app (ou voltar depois de alguns minutos) pede Face ID / Touch ID.
 * A sessão continua salva no aparelho; o desbloqueio confirma a passkey no Supabase.
 */
export function AppLock() {
  const { signOut } = useAuth()
  // acabou de entrar com senha/biometria nesta abertura → não pede de novo
  const [locked, setLocked] = useState(() => passkeySupported() && appLockEnabled() && !isUnlocked())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hiddenAt = useRef<number | null>(null)
  const label = biometricLabel()

  const unlock = useCallback(async (silent = false) => {
    setBusy(true)
    setError(null)
    const e = await unlockWithPasskey()
    setBusy(false)
    // tentativa automática que o navegador barrou (pede toque) não vira mensagem de erro
    if (e && !silent) setError(e)
    else if (!e) setLocked(false)
  }, [])

  // volta ao app depois de um tempo fora → bloqueia de novo
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt.current = Date.now()
      else if (hiddenAt.current && Date.now() - hiddenAt.current > RELOCK_AFTER_MS && passkeySupported() && appLockEnabled()) {
        setError(null)
        clearUnlocked()
        setLocked(true)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // tenta abrir o pedido de biometria sozinho (alguns navegadores exigem o toque no botão)
  useEffect(() => {
    if (locked && document.visibilityState === 'visible') void unlock(true).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked])

  useEffect(() => {
    document.body.style.overflow = locked ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [locked])

  if (!locked) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="lock-title" className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-ink font-display text-2xl font-bold text-lime" aria-hidden>
          F
        </span>
        <h1 id="lock-title" className="font-display text-2xl font-bold">
          Finance bloqueado
        </h1>
        <p className="max-w-xs text-sm text-muted">Use {label} para ver suas finanças.</p>
      </div>
      <button
        type="button"
        onClick={() => void unlock()}
        disabled={busy}
        className="flex h-14 w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-primary-fg disabled:opacity-70"
      >
        <Fingerprint className="size-5" />
        {busy ? 'Aguardando…' : `Desbloquear com ${label}`}
      </button>
      {error ? (
        <p role="alert" className="max-w-xs text-sm text-danger">
          {error}
        </p>
      ) : null}
      <button type="button" onClick={() => void signOut()} className="text-sm font-semibold text-muted underline">
        Entrar com e-mail e senha
      </button>
    </div>
  )
}
