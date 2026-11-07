import { Fingerprint, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  biometricLabel,
  dismissPrompt,
  isEnrolledHere,
  platformAuthenticatorAvailable,
  promptDismissed,
  registerPasskeyOnThisDevice,
} from '@/lib/passkeys'

/** Depois de entrar com senha: oferece ativar Face ID / Touch ID neste aparelho (uma vez). */
export function PasskeyPrompt() {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (isEnrolledHere() || promptDismissed()) return
    void platformAuthenticatorAvailable().then((ok) => setShow(ok))
  }, [])

  if (!show) return null

  const label = biometricLabel()
  const enable = async () => {
    setBusy(true)
    setMsg(null)
    const { error } = await registerPasskeyOnThisDevice()
    setBusy(false)
    if (error) setMsg(error)
    else {
      setDone(true)
      setTimeout(() => setShow(false), 3500)
    }
  }

  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-accent/40 bg-accent-muted p-3 text-sm" role="region" aria-label="Ativar biometria">
      <Fingerprint className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        {done ? (
          <p className="font-medium">Pronto! Da próxima vez é só usar o {label}.</p>
        ) : (
          <>
            <p>
              <strong>Entrar com {label} da próxima vez?</strong>{' '}
              <span className="text-muted">Sem digitar senha. A passkey fica no seu aparelho (e no iCloud, nos aparelhos Apple).</span>
            </p>
            {msg ? <p className="text-xs text-danger">{msg}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void enable()} disabled={busy}>
                {busy ? 'Aguardando…' : `Ativar ${label}`}
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to="/seguranca">Ver aparelhos</Link>
              </Button>
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="Agora não"
        className="rounded-lg p-1 text-muted hover:bg-surface-elevated"
        onClick={() => {
          dismissPrompt()
          setShow(false)
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
