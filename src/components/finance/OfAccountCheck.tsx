import { CreditCard, Landmark, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { mergeOpenFinanceDrafts } from '@/lib/mergeMatch'
import { autoSaveDrafts } from '@/lib/ofAutoImport'
import { fetchOpenFinanceDrafts, readConnections } from '@/lib/openFinance'
import { cn } from '@/lib/utils'
import type { TransactionDraft } from '@/parsers/types'

type Row = { label: string; isCard: boolean; fromBank: number; inApp: number; missing: TransactionDraft[]; ignored: number; pending: number }

const iso = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10)
const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`

/**
 * Confere conta por conta (cartões também) o que o banco mandou × o que está no app,
 * e salva o que falta. Serve para achar por que algo não aparece no Extrato.
 */
export function OfAccountCheck() {
  const { user } = useAuth()
  const conns = readConnections(user)
  const [days, setDays] = useState(45)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState<'check' | 'save' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  if (!conns.length) return null

  const check = async () => {
    if (!user) return
    setBusy('check')
    setErr(null)
    setMsg(null)
    try {
      const to = iso(Date.now())
      const from = iso(Date.now() - days * 86_400_000)
      const r = await fetchOpenFinanceDrafts(conns, from, to, { markSynced: false, onProgress: (d, t) => setProgress(`${Math.round((d / t) * 100)}%`) })
      const m = await mergeOpenFinanceDrafts(user.id, r.drafts)
      const matched = new Set(m.matches.map((x) => x.tempId))
      const byLabel = new Map<string, Row>()
      for (const a of r.accounts) byLabel.set(a.label, { label: a.label, isCard: a.isCard, fromBank: 0, inApp: 0, missing: [], ignored: 0, pending: 0 })
      for (const d of m.drafts) {
        const label = d.accountHint ?? 'Sem conta'
        const row = byLabel.get(label) ?? { label, isCard: /^cart/i.test(label), fromBank: 0, inApp: 0, missing: [], ignored: 0, pending: 0 }
        row.fromBank += 1
        if (d.ofPending) row.pending += 1
        if (matched.has(d.tempId)) row.inApp += 1
        else if (d.excluded) row.ignored += 1
        else row.missing.push(d)
        byLabel.set(label, row)
      }
      setRows([...byLabel.values()].sort((a, b) => Number(b.isCard) - Number(a.isCard) || a.label.localeCompare(b.label, 'pt-BR')))
      if (r.warnings.length) setMsg(r.warnings.join(' '))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const missingAll = (rows ?? []).flatMap((r) => r.missing)
  const saveMissing = async () => {
    if (!user || !missingAll.length) return
    setBusy('save')
    setErr(null)
    try {
      const n = await autoSaveDrafts(user, missingAll)
      setMsg(`${n} lançamento(s) salvo(s). Já aparecem no Extrato.`)
      window.dispatchEvent(new CustomEvent('finance:of-synced'))
      await check()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-base font-semibold">
            <ListChecks className="size-4" /> Conferir contas e cartões
          </h2>
          <p className="text-xs text-muted">O que cada banco mandou × o que está no app. Mostra o que falta e salva.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 rounded-xl border border-border bg-background px-2 text-sm">
          <option value={15}>Últimos 15 dias</option>
          <option value={45}>Últimos 45 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={365}>12 meses</option>
        </select>
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void check()}>
          {busy === 'check' ? `Conferindo… ${progress ?? ''}` : 'Conferir'}
        </Button>
        {missingAll.length ? (
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void saveMissing()}>
            {busy === 'save' ? 'Salvando…' : `Salvar ${missingAll.length} que falta(m)`}
          </Button>
        ) : null}
      </div>
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">{err}</p> : null}
      {msg ? <p className="text-xs text-muted">{msg}</p> : null}
      {rows ? (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const Icon = r.isCard ? CreditCard : Landmark
            const ok = !r.missing.length
            return (
              <li key={r.label} className="rounded-2xl bg-background p-2.5 text-sm">
                <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === r.label ? null : r.label)} disabled={!r.missing.length}>
                  <Icon className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', ok ? 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]' : 'bg-danger/10 text-danger')}>
                    {r.fromBank === 0 ? 'banco não mandou nada' : ok ? 'tudo no app' : `faltam ${r.missing.length}`}
                  </span>
                </button>
                <p className="mt-1 pl-6 text-[11px] text-muted">
                  {r.fromBank} do banco · {r.inApp} já no app{r.ignored ? ` · ${r.ignored} não são gasto (ex.: pagamento da fatura)` : ''}
                  {r.pending ? ` · ${r.pending} pendente(s)` : ''}
                </p>
                {open === r.label && r.missing.length ? (
                  <ul className="mt-1.5 space-y-0.5 pl-6 text-[11px]">
                    {r.missing.slice(0, 40).map((d) => (
                      <li key={d.tempId} className="flex justify-between gap-2">
                        <span className="truncate">
                          {br(d.date)} · {d.descriptionRaw}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {d.kind === 'credit' ? '+' : ''}
                          {formatBRLFromCents(d.amountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {rows && !rows.some((r) => r.isCard) ? (
        <p className="rounded-2xl border border-border p-2.5 text-xs">
          Nenhum cartão de crédito veio das conexões. No Meu Pluggy, confira se cada banco foi conectado com o cartão incluído (na hora de
          autorizar o Open Finance, marque também “cartão de crédito”).
        </p>
      ) : null}
    </section>
  )
}
