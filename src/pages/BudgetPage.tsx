import { format, getDaysInMonth, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useMonthData } from '@/hooks/useMonthData'
import { effectiveTotal, parseBRLToCents, readBudgets, saveBudgets, type Budgets } from '@/lib/budgets'
import { formatBRLFromCents } from '@/lib/currency'
import { shiftMonth } from '@/lib/monthConsolidation'
import { detectRecurring } from '@/lib/recurring'
import { cn } from '@/lib/utils'
import { tileColors } from '@/pages/HomePage'

const brl0 = (c: number) => formatBRLFromCents(c).replace(/,\d\d$/, '')

export function BudgetPage() {
  const { user } = useAuth()
  const today = format(new Date(), 'yyyy-MM-dd')
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const { loading, error, result, categories, monthTxs, history } = useMonthData(month)
  const saved = readBudgets(user)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [draftTotal, setDraftTotal] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) return
    const d: Record<string, string> = {}
    for (const c of categories) {
      const v = saved.byCategory[c.id]
      d[c.id] = v ? (v / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : ''
    }
    setDraft(d)
    setDraftTotal(saved.total ? (saved.total / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const spentByCat = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of result.byCategory) m.set(g.categoryId ?? '__none__', g.totalCents)
    return m
  }, [result])

  const total = effectiveTotal(saved)
  const used = result.totals.expenseCents
  const isCurrent = month === today.slice(0, 7)
  const days = getDaysInMonth(parseISO(`${month}-01`))
  const day = isCurrent ? Number(today.slice(8)) : days
  const usedPct = total ? Math.round((used / total) * 100) : 0
  const idealPct = Math.round((day / days) * 100)
  const freePerDay = total ? Math.max(0, Math.round((total - used) / Math.max(1, days - day + (isCurrent ? 1 : 0)))) : 0

  const rows = categories
    .map((c) => ({ id: c.id, name: c.name, limit: saved.byCategory[c.id] ?? 0, spent: spentByCat.get(c.id) ?? 0 }))
    .filter((r) => r.limit > 0 || r.spent > 0)
    .sort((a, b) => (b.limit > 0 ? 1 : 0) - (a.limit > 0 ? 1 : 0) || b.spent - a.spent)
  const uncategorized = spentByCat.get('__none__') ?? 0

  const subs = useMemo(
    () => detectRecurring(month, monthTxs, history).filter((r) => r.isSubscription),
    [month, monthTxs, history],
  )
  const subsTotal = subs.reduce((s, r) => s + r.amountCents, 0)

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const byCategory: Budgets['byCategory'] = {}
    for (const [id, v] of Object.entries(draft) as [string, string][]) {
      const c = parseBRLToCents(v)
      if (c && c > 0) byCategory[id] = c
    }
    const t = parseBRLToCents(draftTotal)
    const err = await saveBudgets({ total: t && t > 0 ? t : null, byCategory })
    setBusy(false)
    if (err) setMsg(`Não consegui salvar: ${err}`)
    else {
      setEditing(false)
      setMsg('Limites salvos. Valem para todos os meses e aparecem no iPhone e no Mac.')
    }
  }

  const monthName = format(parseISO(`${month}-01`), 'LLLL', { locale: ptBR })

  if (editing) {
    return (
      <div className="space-y-4 pb-24">
        <header className="flex items-center justify-between">
          <h1 className="text-[30px] font-bold tracking-tight">Limites</h1>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        </header>
        <p className="text-sm text-muted">Quanto quer gastar por mês em cada categoria. Deixe em branco para não limitar.</p>
        <section className="space-y-1 rounded-3xl border border-border bg-surface p-[18px]">
          <label className="flex items-center gap-3 border-b border-border pb-3">
            <span className="flex-1 font-semibold">Limite total do mês</span>
            <input
              inputMode="decimal"
              placeholder="soma das categorias"
              value={draftTotal}
              onChange={(e) => setDraftTotal(e.target.value)}
              className="h-10 w-36 rounded-xl border border-border bg-background px-3 text-right tabular-nums"
            />
          </label>
          {categories.map((c) => (
            <label key={c.id} className="flex items-center gap-3 py-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] font-display text-[15px] font-bold" style={tileColors(c.name)}>
                {c.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.name}</span>
                <span className="block text-xs text-muted">gastou {formatBRLFromCents(spentByCat.get(c.id) ?? 0)} em {monthName}</span>
              </span>
              <input
                inputMode="decimal"
                placeholder="—"
                aria-label={`Limite de ${c.name}`}
                value={draft[c.id] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                className="h-10 w-28 rounded-xl border border-border bg-background px-3 text-right tabular-nums"
              />
            </label>
          ))}
        </section>
        {msg ? <p className="text-sm text-danger">{msg}</p> : null}
        <Button className="h-12 w-full text-base" onClick={() => void save()} disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar limites'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3.5 pb-24">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface">
            <ChevronLeft className="size-4" />
          </button>
          <div>
            <p className="text-[13px] capitalize text-muted">{monthName}</p>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight">Orçamento</h1>
          </div>
          <button type="button" aria-label="Próximo mês" onClick={() => setMonth((m) => shiftMonth(m, 1))} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface">
            <ChevronRight className="size-4" />
          </button>
        </div>
        <Button variant="secondary" className="rounded-[14px]" onClick={() => setEditing(true)}>
          Ajustar limites
        </Button>
      </header>

      {error ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      {msg ? <p className="rounded-2xl bg-accent-muted p-3 text-sm" role="status">{msg}</p> : null}

      <section className="space-y-4 rounded-[28px] bg-ink px-[22px] py-5 text-[#f2f3ee]">
        {total ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <div className="space-y-1.5">
                <p className="text-[13px] text-[#b9bdb4]">Usado do limite mensal</p>
                <p className="font-display text-[34px] font-bold leading-none">
                  {brl0(used)} <span className="text-lg font-medium text-[#b9bdb4]">de {brl0(total).replace('R$ ', '')}</span>
                </p>
              </div>
              <span className={cn('text-[13px] font-semibold', usedPct > 100 ? 'text-[#f28c6b]' : 'text-lime')}>{usedPct}%</span>
            </div>
            <div className="relative h-3 rounded-full bg-[#2c3036]">
              <div className={cn('absolute left-0 top-0 h-3 rounded-full', usedPct > 100 ? 'bg-[#f28c6b]' : 'bg-lime')} style={{ width: `${Math.min(100, usedPct)}%` }} />
              {isCurrent ? <div className="absolute -top-[5px] h-[22px] w-0.5 bg-[#f2f3ee]" style={{ left: `${idealPct}%` }} aria-hidden /> : null}
            </div>
            <div className="flex justify-between text-xs text-[#b9bdb4]">
              <span>{isCurrent ? `Hoje é dia ${day} · o ideal seria ${idealPct}%` : `Mês fechado · ${usedPct}% do limite`}</span>
              {isCurrent ? <span>{brl0(freePerDay)}/dia livre</span> : null}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-[#b9bdb4]">Gasto em {monthName}</p>
            <p className="font-display text-[34px] font-bold leading-none">{brl0(used)}</p>
            <p className="text-sm text-[#b9bdb4]">Defina limites por categoria para ver quanto ainda pode gastar e o ritmo ideal do mês.</p>
            <Button className="bg-lime text-ink hover:bg-lime" onClick={() => setEditing(true)}>
              Definir limites
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-border bg-surface px-[18px] py-1.5">
        {loading && rows.length === 0 ? <p className="py-4 text-sm text-muted">Carregando…</p> : null}
        {!loading && rows.length === 0 ? <p className="py-4 text-sm text-muted">Nenhum gasto neste mês.</p> : null}
        {rows.map((r) => {
          const over = r.limit > 0 && r.spent > r.limit
          const pct = r.limit > 0 ? Math.min(100, Math.round((r.spent / r.limit) * 100)) : 0
          const near = !over && pct >= 80
          return (
            <div key={r.id} className="space-y-2 border-b border-[#eeefe9] py-3.5 last:border-0 dark:border-[#2b2e34]">
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] font-display text-[15px] font-bold" style={tileColors(r.name)}>
                  {r.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className={cn('text-xs', over ? 'font-semibold text-danger' : 'text-muted')}>
                    {r.limit === 0
                      ? 'Sem limite definido'
                      : over
                        ? `Passou ${formatBRLFromCents(r.spent - r.limit).replace(/,00$/, '')} do limite`
                        : `Restam ${formatBRLFromCents(r.limit - r.spent).replace(/,00$/, '')} de ${formatBRLFromCents(r.limit).replace(/,00$/, '')}`}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums">{brl0(r.spent)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-[#eeefe9] dark:bg-[#2b2e34]">
                {r.limit > 0 ? (
                  <div className={cn('h-1.5 rounded-full', over ? 'bg-danger' : near ? 'bg-warning' : 'bg-foreground')} style={{ width: `${Math.max(2, pct)}%` }} />
                ) : null}
              </div>
            </div>
          )
        })}
        {uncategorized > 0 ? (
          <div className="flex items-center justify-between py-3.5 text-sm">
            <span className="text-muted">Sem categoria</span>
            <span className="font-semibold tabular-nums text-warning">{brl0(uncategorized)}</span>
          </div>
        ) : null}
      </section>

      {subs.length ? (
        <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Assinaturas detectadas</h2>
            <span className="text-[13px] text-muted">{brl0(subsTotal)}/mês</span>
          </div>
          <p className="text-[13px] leading-snug text-muted">
            Cobranças que se repetem todo mês com o mesmo valor, encontradas nos seus extratos.
          </p>
          <div className="flex flex-wrap gap-2">
            {subs.map((r) => (
              <span
                key={r.key}
                className={cn(
                  'rounded-full px-3 py-2 text-[13px]',
                  r.paidThisMonth || !isCurrent ? 'bg-background' : 'bg-accent-muted',
                )}
              >
                {r.name} · {formatBRLFromCents(r.amountCents).replace('R$ ', '')}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
