import { Fingerprint, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  biometricLabel,
  deletePasskey,
  forgetEnrolledHere,
  listPasskeys,
  passkeySupported,
  platformAuthenticatorAvailable,
  registerPasskeyOnThisDevice,
  type PasskeyInfo,
} from '@/lib/passkeys'

export function SecurityPage() {
  const [items, setItems] = useState<PasskeyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasBiometric, setHasBiometric] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: e } = await listPasskeys()
    setItems(data)
    setError(e)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    void platformAuthenticatorAvailable().then(setHasBiometric)
  }, [load])

  const add = async () => {
    setBusy(true)
    setMsg(null)
    setError(null)
    const { error: e } = await registerPasskeyOnThisDevice()
    setBusy(false)
    if (e) setError(e)
    else {
      setMsg(`Pronto! Este aparelho já entra com ${biometricLabel()}.`)
      void load()
    }
  }

  const remove = async (id: string) => {
    setConfirmId(null)
    const e = await deletePasskey(id)
    if (e) setError(e)
    else {
      forgetEnrolledHere()
      setMsg('Passkey removida.')
      void load()
    }
  }

  const label = biometricLabel()
  return (
    <div className="space-y-5 pb-24">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Segurança</h1>
        <p className="text-sm text-muted">Entre sem senha usando Face ID, Touch ID ou a digital do aparelho.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="size-4 text-accent" aria-hidden /> Este aparelho
          </CardTitle>
          <CardDescription>
            {!passkeySupported()
              ? 'Este navegador não suporta passkeys. Use Safari ou Chrome atualizados.'
              : hasBiometric
                ? `Ative para entrar com ${label}. Nos aparelhos Apple a passkey é sincronizada pelo iCloud Keychain, então ativar no iPhone também vale para o Mac com a mesma conta Apple (e vice-versa).`
                : 'Não encontrei biometria neste aparelho, mas você pode usar uma passkey do celular ou uma chave de segurança.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {passkeySupported() ? (
            <Button onClick={() => void add()} disabled={busy}>
              <Fingerprint className="size-4" />
              {busy ? 'Aguardando…' : `Ativar ${label} neste aparelho`}
            </Button>
          ) : null}
          {msg ? <p className="text-sm text-accent" role="status">{msg}</p> : null}
          {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Passkeys cadastradas</CardTitle>
          <CardDescription>Remova as de aparelhos que você não usa mais.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted">Carregando…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted">Nenhuma ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{p.friendly_name || 'Passkey'}</p>
                    <p className="text-xs text-muted">
                      Criada em {new Date(p.created_at).toLocaleDateString('pt-BR')}
                      {p.last_used_at ? ` · último uso ${new Date(p.last_used_at).toLocaleDateString('pt-BR')}` : ''}
                    </p>
                  </div>
                  {confirmId === p.id ? (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="danger" onClick={() => void remove(p.id)}>
                        Remover
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" aria-label="Remover passkey" onClick={() => setConfirmId(p.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
