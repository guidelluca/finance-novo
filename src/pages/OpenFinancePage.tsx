import { Check, Copy, ExternalLink, Plus, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import fnCode from '../../supabase/functions/pluggy-sync/index.ts?raw'
import { OfAccountCheck } from '@/components/finance/OfAccountCheck'
import { OfCardsPanel } from '@/components/finance/OfCardsPanel'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { findSavedDuplicates, mergeSavedDuplicates, type DupPair } from '@/lib/mergeMatch'
import { OF_BANKS, ofRefresh, ofStatus, readConnections, saveConnections, type OfConnection, type OfItemStatus } from '@/lib/openFinance'
import { cn } from '@/lib/utils'

const inputCls = 'h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground'

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true)
          setTimeout(() => setOk(false), 1800)
        })
      }}
    >
      {ok ? <Check className="size-4" /> : <Copy className="size-4" />} {ok ? 'Copiado' : label}
    </Button>
  )
}

const STATUS_LABEL: Record<string, string> = {
  UPDATED: 'atualizado',
  UPDATING: 'atualizando…',
  OUTDATED: 'desatualizado',
  LOGIN_ERROR: 'precisa reconectar',
  WAITING_USER_INPUT: 'esperando você',
}

/** Configuração do Open Finance pelo Meu Pluggy: passo a passo + conexões. */
export function OpenFinancePage() {
  const { user } = useAuth()
  const conns = readConnections(user)
  const [bank, setBank] = useState<string>(OF_BANKS[0])
  const [itemId, setItemId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<OfItemStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dups, setDups] = useState<DupPair[] | null>(null)
  const [mergedMsg, setMergedMsg] = useState<string | null>(null)
  const scanDups = async () => {
    if (!user) return
    setBusy('dups')
    setErr(null)
    setMergedMsg(null)
    try {
      setDups(await findSavedDuplicates(user.id))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const doMerge = async () => {
    if (!user || !dups?.length) return
    setBusy('merge')
    try {
      const n = await mergeSavedDuplicates(user.id, dups)
      setMergedMsg(`${n} repetido(s) juntado(s). Ficou o lançamento antigo, com a categoria e a viagem do novo quando faltavam.`)
      setDups([])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const ref = (import.meta.env.VITE_SUPABASE_URL ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
  const dash = ref ? `https://supabase.com/dashboard/project/${ref}` : 'https://supabase.com/dashboard'

  const add = async () => {
    const id = itemId.trim()
    if (!/^[0-9a-f-]{36}$/i.test(id)) return setErr('O itemId tem 36 caracteres, como 1a2b3c4d-....')
    if (conns.some((c) => c.itemId === id)) return setErr('Essa conexão já está cadastrada.')
    setErr(null)
    try {
      await saveConnections([...conns, { itemId: id, bank }])
      setItemId('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const remove = async (c: OfConnection) => {
    try {
      await saveConnections(conns.filter((x) => x.itemId !== c.itemId))
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const test = async () => {
    setBusy('test')
    setErr(null)
    try {
      setStatus((await ofStatus(conns.map((c) => c.itemId))).items)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const refresh = async () => {
    setBusy('refresh')
    setErr(null)
    try {
      await ofRefresh(conns.map((c) => c.itemId))
      setStatus((await ofStatus(conns.map((c) => c.itemId))).items)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const Step = ({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) => (
    <li className="space-y-2 rounded-2xl bg-background p-3.5">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className={cn('flex size-6 items-center justify-center rounded-full text-xs', done ? 'bg-lime text-ink' : 'bg-ink text-[#f2f3ee]')}>
          {done ? <Check className="size-3.5" /> : n}
        </span>
        {title}
      </p>
      <div className="space-y-2 pl-8 text-sm text-muted">{children}</div>
    </li>
  )

  return (
    <div className="space-y-3.5 pb-24">
      <header>
        <h1 className="text-[30px] font-bold tracking-tight">Open Finance</h1>
        <p className="text-sm text-muted">Seus bancos entram sozinhos, só leitura, pelo Meu Pluggy (grátis para uso pessoal, até 5 conexões).</p>
      </header>
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{err}</p> : null}
      <Link to="/panorama" className="flex items-center justify-between rounded-2xl bg-accent-muted p-3 text-sm font-semibold">
        Panorama: patrimônio, saldos, investimentos, dívidas, assinaturas e alertas <span aria-hidden>→</span>
      </Link>
      <Link to="/import?of=all" className="flex items-center justify-between rounded-2xl border border-border bg-surface p-3 text-sm font-semibold">
        Trazer tudo dos bancos (12 meses), sem repetir o que já está no app <span aria-hidden>→</span>
      </Link>
      <OfAccountCheck />
      <OfCardsPanel compact />

      <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Conexões</h2>
          {conns.length ? (
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>
                <RefreshCw className={cn('size-4', busy === 'refresh' && 'animate-spin')} /> Atualizar
              </Button>
              <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void test()}>
                {busy === 'test' ? 'Testando…' : 'Testar'}
              </Button>
            </div>
          ) : null}
        </div>
        {conns.length === 0 ? <p className="text-sm text-muted">Nenhuma ainda. Siga os passos abaixo e cadastre o itemId de cada banco.</p> : null}
        <ul className="space-y-1.5">
          {conns.map((c) => {
            const st = status?.find((s) => s.id === c.itemId)
            return (
              <li key={c.itemId} className="rounded-2xl bg-background p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{c.bank}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{c.itemId}</span>
                  </span>
                  {st ? (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        st.error || st.status === 'LOGIN_ERROR' ? 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]' : 'bg-[#eef7d8] text-[#3f5a12] dark:bg-[#2a3317] dark:text-[#c8f169]',
                      )}
                    >
                      {st.error ? 'erro' : (STATUS_LABEL[st.status ?? ''] ?? st.status)}
                    </span>
                  ) : null}
                  <button type="button" onClick={() => void remove(c)} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Remover conexão">
                    <X className="size-4" />
                  </button>
                </div>
                {st?.error ? <p className="mt-1 text-xs text-danger">{st.error}</p> : null}
                {st?.accounts?.length ? (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                    {st.accounts.map((a) => (
                      <li key={a.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {a.type === 'CREDIT' ? 'Cartão' : 'Conta'} · {a.name} {a.number ? `•${String(a.number).slice(-4)}` : ''}
                        </span>
                        <span className="tabular-nums">{formatBRLFromCents(Math.round((a.balance ?? 0) * 100))}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {st?.lastUpdatedAt ? <p className="mt-1 text-[11px] text-muted">Atualizado em {new Date(st.lastUpdatedAt).toLocaleString('pt-BR')}</p> : null}
              </li>
            )
          })}
        </ul>
        {conns.length < 5 ? (
          <div className="grid grid-cols-[auto_1fr_auto] gap-2">
            <select className="h-11 rounded-xl border border-border bg-background px-2 text-sm" value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Banco">
              {OF_BANKS.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <input className={inputCls} placeholder="itemId da conexão" value={itemId} onChange={(e) => setItemId(e.target.value)} />
            <Button className="h-11" onClick={() => void add()}>
              <Plus className="size-4" />
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Limite do Meu Pluggy gratuito: 5 conexões.</p>
        )}
        {conns.length ? (
          <Link to="/import" className="inline-block text-sm font-semibold underline">
            Buscar lançamentos em Adicionar →
          </Link>
        ) : null}
      </section>

      {conns.length ? (
        <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">Repetidos já salvos</h2>
              <p className="text-xs text-muted">Lançamentos do Open Finance que repetem um que já estava no app (PDF, print ou manual).</p>
            </div>
            <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void scanDups()}>
              {busy === 'dups' ? 'Procurando…' : 'Procurar'}
            </Button>
          </div>
          {mergedMsg ? <p className="rounded-xl bg-accent-muted p-2.5 text-sm">{mergedMsg}</p> : null}
          {dups && dups.length === 0 && !mergedMsg ? <p className="text-sm text-muted">Nenhum repetido. Tudo certo.</p> : null}
          {dups && dups.length ? (
            <>
              <ul className="max-h-80 space-y-1.5 overflow-y-auto text-xs">
                {dups.map((p) => (
                  <li key={p.of.id} className="rounded-xl bg-background p-2.5">
                    <p className="flex justify-between gap-2 font-semibold">
                      <span className="truncate">{p.old.description_raw}</span>
                      <span className="shrink-0 tabular-nums">{formatBRLFromCents(p.old.amount_cents)}</span>
                    </p>
                    <p className="text-muted">
                      fica: {p.old.date.split('-').reverse().join('/')} · {p.old.account ?? 'sem conta'} — sai (Open Finance): {p.of.date.split('-').reverse().join('/')} · {p.of.description_raw}
                    </p>
                  </li>
                ))}
              </ul>
              <Button className="w-full" disabled={Boolean(busy)} onClick={() => void doMerge()}>
                {busy === 'merge' ? 'Juntando…' : `Juntar ${dups.length} repetido(s)`}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
        <h2 className="text-base font-semibold">Como configurar (uma vez)</h2>
        <ol className="space-y-2">
          <Step n={1} title="Crie a conta de desenvolvedor na Pluggy">
            <p>
              Entre em{' '}
              <a className="font-semibold text-foreground underline" href="https://dashboard.pluggy.ai" target="_blank" rel="noreferrer">
                dashboard.pluggy.ai <ExternalLink className="inline size-3" />
              </a>
              , crie uma aplicação e anote o <strong>Client ID</strong> e o <strong>Client Secret</strong>. O teste grátis dura 14 dias: faça os passos 2 e 3 dentro dele.
            </p>
          </Step>
          <Step n={2} title="Conecte seus bancos no Meu Pluggy">
            <p>
              Em{' '}
              <a className="font-semibold text-foreground underline" href="https://meu.pluggy.ai" target="_blank" rel="noreferrer">
                meu.pluggy.ai <ExternalLink className="inline size-3" />
              </a>{' '}
              (com o mesmo e-mail), conecte Itaú, Nubank, Mercado Pago, PicPay e Inter pelo Open Finance. A autorização é feita no app de cada banco.
            </p>
          </Step>
          <Step n={3} title="Pegue o itemId de cada banco">
            <p>
              No dashboard da Pluggy, adicione o conector <strong>MeuPluggy</strong> à sua aplicação e conecte cada banco por ele. Cada conexão mostra um <strong>itemId</strong>: cadastre-o acima junto com o banco.
            </p>
          </Step>
          <Step n={4} title="Publique a função no Supabase">
            <p>
              No{' '}
              <a className="font-semibold text-foreground underline" href={`${dash}/functions`} target="_blank" rel="noreferrer">
                Supabase → Edge Functions <ExternalLink className="inline size-3" />
              </a>{' '}
              → <strong>Deploy a new function</strong> → <strong>Via Editor</strong>. Nome: <code className="text-foreground">pluggy-sync</code>. Apague o exemplo, cole o código e toque em <strong>Deploy</strong>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyBtn text={fnCode} label="Copiar código da função" />
            </div>
          </Step>
          <Step n={5} title="Guarde os segredos no Supabase (nunca no app)">
            <p>
              Em{' '}
              <a className="font-semibold text-foreground underline" href={`${dash}/functions/secrets`} target="_blank" rel="noreferrer">
                Edge Functions → Secrets <ExternalLink className="inline size-3" />
              </a>
              , adicione três:
            </p>
            <ul className="space-y-1.5">
              <li>
                <code className="text-foreground">PLUGGY_CLIENT_ID</code> = Client ID da Pluggy
              </li>
              <li>
                <code className="text-foreground">PLUGGY_CLIENT_SECRET</code> = Client Secret da Pluggy
              </li>
              <li className="space-y-1">
                <span>
                  <code className="text-foreground">ALLOWED_USER_ID</code> = o seu id (só você consegue usar a função):
                </span>
                <span className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1 font-mono text-[11px] text-foreground">{user?.id}</code>
                  {user ? <CopyBtn text={user.id} label="Copiar" /> : null}
                </span>
              </li>
            </ul>
          </Step>
          <Step n={6} title="Teste">
            <p>Cadastre os itemIds acima e toque em <strong>Testar</strong>: aparecem as contas, os cartões e os saldos de cada banco. Depois é só usar <strong>Buscar lançamentos</strong> em Adicionar.</p>
          </Step>
        </ol>
        <p className="text-xs text-muted">
          Segurança: a chave da Pluggy fica só no servidor do Supabase; o app guarda apenas os itemIds, que não dão acesso a nada sozinhos. A função só responde ao seu usuário. Para cortar o acesso, revogue o consentimento no app do banco ou no Meu Pluggy.
        </p>
      </section>
    </div>
  )
}
