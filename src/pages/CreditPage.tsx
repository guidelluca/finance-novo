import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronDown, ChevronLeft, ChevronRight, CreditCard, HeartPulse, Layers, ReceiptText, Store, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { FutureInstallments } from '@/components/finance/FutureInstallments'
import { OfCardsPanel } from '@/components/finance/OfCardsPanel'
import { ListSkeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/contexts/AuthContext'
import { useChartTheme } from '@/hooks/useChartTheme'
import { useCountUp } from '@/hooks/useCountUp'
import { usePeriods } from '@/hooks/usePeriods'
import { AdvicePanel } from '@/components/finance/AdvicePanel'
import { cardLedger, creditHealth, incomeOf } from '@/lib/creditHealth'
import { detectSubscriptions, projectInstallments } from '@/lib/ofInsights'
import { withLimitOverrides, readCardsCache } from '@/lib/openFinance'
import type { AdviceInput } from '@/lib/spendingAdvice'
import { analyzeMonth, cardName, creditMovements, cumulative, installmentOf, sumSigned, type Cat, type CreditRow } from '@/lib/creditAnalysis'
import { formatBRLFromCents } from '@/lib/currency'
import { shiftMonth } from '@/lib/monthConsolidation'
import { OF_SYNC_EVENT } from '@/lib/ofAutoSync'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const BR = formatBRLFromCents
const BR0 = (c: number) => formatBRLFromCents(c).replace(/,\d{2}$/, '')
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const monthLabel = (m: string, pattern = 'LLLL') => format(parseISO(`${m}-01`), pattern, { locale: ptBR })

function Panel({ icon: Icon, title, right, children, className }: { icon: typeof CreditCard; title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rise space-y-3 rounded-3xl border border-border bg-surface p-4', className)}>
      <header className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-xl bg-background">
          <Icon className="size-3.5 text-muted" />
        </span>
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  )
}

/** Análise do gasto no crédito: todos os cartões ou um só, mês a mês. */
export function CreditPage() {
  const { user } = useAuth()
  const periods = usePeriods()
  const ct = useChartTheme()
  const [month, setMonth] = useState<string | null>(null)
  const cur = month ?? periods.current
  const [card, setCard] = useState<string | null>(null)
  const [rows, setRows] = useState<CreditRow[]>([])
  const [allRows, setAllRows] = useState<CreditRow[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [openCat, setOpenCat] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const on = () => setTick((x) => x + 1)
    window.addEventListener(OF_SYNC_EVENT, on)
    window.addEventListener('finance:recategorized', on)
    return () => {
      window.removeEventListener(OF_SYNC_EVENT, on)
      window.removeEventListener('finance:recategorized', on)
    }
  }, [])

  useEffect(() => {
    if (!user || !periods.ready) return
    let alive = true
    const since = periods.rangeOf(shiftMonth(periods.current, -12)).start
    void (async () => {
      const out: CreditRow[] = []
      for (let i = 0; i < 30000; i += 1000) {
        const { data, error } = await supabase
          .from('transactions')
          .select('id, date, amount_cents, kind, description_raw, account, credit_card_id, category_id')
          .eq('user_id', user.id)
          .gte('date', since)
          .order('date')
          .range(i, i + 999)
        if (error) {
          if (alive) setErr(error.message)
          break
        }
        out.push(...((data ?? []) as CreditRow[]))
        if (!data || data.length < 1000) break
      }
      const { data: cc } = await supabase.from('categories').select('id, name, parent_id').eq('user_id', user.id)
      if (!alive) return
      setRows(creditMovements(out))
      setAllRows(out)
      setCats((cc ?? []) as Cat[])
      setLoading(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, periods.ready, periods.current, tick])

  // cor fixa por cartão (ordem alfabética): filtrar não repinta os outros
  const cards = useMemo(() => [...new Set(rows.map(cardName))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [rows])
  const colorOf = (c: string) => SERIES[cards.indexOf(c)] ?? 'var(--series-muted)'

  const scoped = useMemo(() => (card ? rows.filter((t) => cardName(t) === card) : rows), [rows, card])
  const inMonth = (m: string) => scoped.filter((t) => periods.periodOf(t.date) === m)
  const monthRows = useMemo(() => inMonth(cur), [scoped, cur, periods]) // eslint-disable-line react-hooks/exhaustive-deps
  const prevRows = useMemo(() => inMonth(shiftMonth(cur, -1)), [scoped, cur, periods]) // eslint-disable-line react-hooks/exhaustive-deps
  const a = useMemo(() => analyzeMonth(monthRows, cats), [monthRows, cats])

  // ---- saúde do cartão (todos os cartões, contra a renda do mês)
  const monthAll = useMemo(() => allRows.filter((t) => periods.periodOf(t.date) === cur), [allRows, cur, periods])
  const allCreditMonth = useMemo(() => rows.filter((t) => periods.periodOf(t.date) === cur), [rows, cur, periods])
  const manualIncome = Number(user?.user_metadata?.net_income_cents ?? 0) || 0
  const extratoIncome = incomeOf(monthAll)
  const incomeCents = manualIncome || extratoIncome
  const [editIncome, setEditIncome] = useState(false)
  const [incomeInput, setIncomeInput] = useState('')
  const saveIncome = async () => {
    const v = Math.round(Number(incomeInput.replace(/\./g, '').replace(',', '.')) * 100)
    await supabase.auth.updateUser({ data: { net_income_cents: Number.isFinite(v) && v > 0 ? v : null } })
    setEditIncome(false)
  }
  const nextYm = (() => {
    const [y, m] = periods.today.split('-').map(Number)
    const d = new Date(Date.UTC(y!, m!, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })()
  const nextInst = useMemo(() => projectInstallments(rows, periods.today).find((m) => m.ym === nextYm)?.cents ?? 0, [rows, periods.today, nextYm])
  const ofCards = useMemo(() => {
    const c = readCardsCache()
    return c ? { ...c, cards: withLimitOverrides(c.cards, user) } : null
  }, [tick, user]) // eslint-disable-line react-hooks/exhaustive-deps
  const daysLeftHealth = Math.max(0, Math.round((Date.parse(`${periods.rangeOf(cur).end}T12:00:00Z`) - Date.parse(`${periods.today}T12:00:00Z`)) / 86_400_000) + 1)
  const health = creditHealth({
    spentCents: sumSigned(allCreditMonth),
    incomeCents,
    incomeSource: manualIncome ? 'manual' : extratoIncome ? 'extrato' : null,
    daysLeft: cur === periods.current ? daysLeftHealth : 0,
    nextMonthInstallmentsCents: nextInst,
    ofCards,
  })
  const ledger = useMemo(
    () => cardLedger({ monthCredit: allCreditMonth, monthAll, allCredit: rows, today: periods.today, ofCards }),
    [allCreditMonth, monthAll, rows, periods.today, ofCards],
  )
  const adviceInput = useMemo<AdviceInput | null>(() => {
    if (!rows.length) return null
    const all = analyzeMonth(allCreditMonth, cats)
    const prevMonths = [1, 2, 3].map((k) => shiftMonth(cur, -k))
    const avgBy = new Map<string, number>()
    for (const pm of prevMonths) {
      const am = analyzeMonth(rows.filter((t) => periods.periodOf(t.date) === pm), cats)
      for (const c of am.byCategory) avgBy.set(c.name, (avgBy.get(c.name) ?? 0) + c.cents / 3)
    }
    return {
      scope: 'credito',
      month: monthLabel(cur, "LLLL 'de' yyyy"),
      incomeCents,
      spentCents: sumSigned(allCreditMonth),
      daysLeft: cur === periods.current ? daysLeftHealth : 0,
      categories: all.byCategory.slice(0, 10).map((c) => ({ name: c.name, cents: c.cents, avgCents: Math.round(avgBy.get(c.name) ?? 0) })),
      credit: { spentCents: health.spentCents, pct: health.pct, safeCents: health.safeCents, nextMonthInstallmentsCents: nextInst, limitUsePct: health.limitUsePct },
      subscriptions: detectSubscriptions(allRows, periods.today).map((x) => ({ name: x.name, cents: x.monthlyCents, increasePct: x.increasePct })),
    }
  }, [rows, allRows, allCreditMonth, cats, cur, periods, incomeCents, health.spentCents, health.pct, health.safeCents, health.limitUsePct, nextInst, daysLeftHealth])

  const range = periods.rangeOf(cur)
  const prevRange = periods.rangeOf(shiftMonth(cur, -1))
  const days = Math.round((Date.parse(`${range.end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000) + 1
  const isCurrent = cur === periods.current
  const todayIdx = isCurrent ? Math.min(days - 1, Math.round((Date.parse(`${periods.today}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000)) : days - 1
  const curCum = cumulative(monthRows, range.start, days)
  const prevCum = cumulative(prevRows, prevRange.start, days)
  const prevSameDay = prevCum[todayIdx] ?? 0
  const delta = prevSameDay > 0 ? (curCum[todayIdx] ?? 0) / prevSameDay - 1 : null
  const pace = curCum.map((v, i) => ({ dia: i + 1, este: i <= todayIdx ? v / 100 : null, anterior: (prevCum[i] ?? 0) / 100 }))

  const history = useMemo(() => {
    const ms = Array.from({ length: 6 }, (_, i) => shiftMonth(cur, i - 5))
    return ms.map((m) => {
      const r: Record<string, number | string> = { mes: monthLabel(m, 'LLL') }
      for (const c of card ? [card] : cards) r[c] = sumSigned(rows.filter((t) => cardName(t) === c && periods.periodOf(t.date) === m)) / 100
      return r
    })
  }, [rows, cards, card, cur, periods])
  const avg6 = useMemo(() => {
    const vals = history.slice(0, 5).map((h) => Object.entries(h).filter(([k]) => k !== 'mes').reduce((s, [, v]) => s + Number(v), 0))
    const filled = vals.filter((v) => v > 0)
    return filled.length ? Math.round((filled.reduce((s, v) => s + v, 0) / filled.length) * 100) : 0
  }, [history])

  const animated = useCountUp(loading ? 0 : a.totalCents)
  const tooltipStyle = { background: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: 12, color: ct.tooltipColor, fontSize: 12 }
  const brlTip = (v: unknown) => (typeof v === 'number' ? BR(Math.round(v * 100)) : '—')
  const maxCat = Math.max(1, ...a.byCategory.map((c) => c.cents))
  const instShare = a.cashCents + a.installmentsCents ? a.installmentsCents / (a.cashCents + a.installmentsCents) : 0

  return (
    <div className="space-y-3.5 pb-24">
      {/* mês */}
      <div className="flex items-center justify-center gap-1">
        <button type="button" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(cur, -1))} className="flex size-11 items-center justify-center rounded-xl hover:bg-surface">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-[140px] text-center">
          <p className="font-display text-xl font-semibold first-letter:uppercase">Crédito · {monthLabel(cur)}</p>
          <p className="text-xs font-medium text-muted">
            {range.start.slice(8)}/{range.start.slice(5, 7)} – {range.end.slice(8)}/{range.end.slice(5, 7)} · pela data da compra
          </p>
        </div>
        <button type="button" aria-label="Próximo mês" onClick={() => setMonth(shiftMonth(cur, 1))} className="flex size-11 items-center justify-center rounded-xl hover:bg-surface">
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* filtro por cartão: uma linha, acima de tudo */}
      {cards.length > 1 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Cartão">
          {[null, ...cards].map((c) => (
            <button
              key={c ?? 'todos'}
              type="button"
              role="tab"
              aria-selected={card === c}
              onClick={() => setCard(c)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                card === c ? 'border-transparent bg-ink text-[#f2f3ee]' : 'border-border bg-surface text-foreground',
              )}
            >
              {c ? <span className="size-2 rounded-full" style={{ background: colorOf(c) }} /> : null}
              {c ?? 'Todos os cartões'}
            </button>
          ))}
        </div>
      ) : null}

      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{err}</p> : null}

      {/* número do mês */}
      <section className="rise space-y-4 rounded-[28px] bg-ink p-[22px] text-[#f2f3ee]">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <p className="text-[13px] text-[#b9bdb4]">{card ? `Gasto no ${card}` : 'Gasto no crédito'}</p>
            <p className="font-display text-[42px] font-bold leading-none tracking-[-1px]">{loading ? '…' : BR(animated)}</p>
          </div>
          {delta != null && Number.isFinite(delta) ? (
            <span
              className={cn('flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold text-ink', delta <= 0 ? 'bg-lime' : 'bg-[#f28c6b]')}
              title={isCurrent ? `Até o ${todayIdx + 1}º dia, contra o mesmo trecho do mês anterior` : 'Contra o mês anterior inteiro'}
            >
              {delta <= 0 ? <TrendingDown className="size-3.5" /> : <TrendingUp className="size-3.5" />}
              {delta <= 0 ? '−' : '+'}
              {Math.abs(Math.round(delta * 100))}%
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {[
            ['Compras', String(a.purchases)],
            ['Ticket médio', BR0(a.avgTicketCents)],
            ['Média mensal', avg6 ? BR0(avg6) : '—'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl bg-white/5 p-2.5">
              <dt className="text-[#b9bdb4]">{k}</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {!card && a.byCard.length > 1 ? (
          <div className="space-y-1.5">
            <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Divisão por cartão">
              {a.byCard
                .filter((c) => c.cents > 0)
                .map((c) => (
                  <span key={c.card} style={{ width: `${(c.cents / Math.max(1, a.totalCents)) * 100}%`, background: colorOf(c.card) }} />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#b9bdb4]">
              {a.byCard.map((c) => (
                <button key={c.card} type="button" onClick={() => setCard(c.card)} className="inline-flex items-center gap-1">
                  <i className="size-2 rounded-full" style={{ background: colorOf(c.card) }} />
                  {c.card} <b className="text-[#f2f3ee]">{BR0(c.cents)}</b>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {a.refundsCents ? <p className="text-[11px] text-[#b9bdb4]">Já descontados {BR(a.refundsCents)} de estornos.</p> : null}
      </section>


      {!loading && rows.length ? (
        <>
          <Panel icon={HeartPulse} title="Saúde do cartão" right={<span className="text-xs text-muted">todos os cartões</span>}>
            {health.status === 'sem_renda' ? (
              <p className="text-sm text-muted">Não achei salário neste mês. Informe sua renda líquida para ver quanto do cartão cabe nela.</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="relative h-3 overflow-hidden rounded-full bg-border/60" role="img" aria-label={`Crédito em ${Math.round((health.pct ?? 0) * 100)}% da renda`}>
                    <span
                      className={cn('absolute inset-y-0 left-0 rounded-full', health.status === 'saudavel' ? 'bg-[var(--series-3)]' : health.status === 'atencao' ? 'bg-[var(--series-4)]' : 'bg-danger')}
                      style={{ width: `${Math.min(100, ((health.pct ?? 0) / 0.6) * 100)}%` }}
                    />
                    <span className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${(0.3 / 0.6) * 100}%` }} aria-hidden />
                  </div>
                  <div className="flex justify-between text-[11px] text-muted">
                    <span>0%</span>
                    <span>teto saudável 30%</span>
                    <span>60%</span>
                  </div>
                </div>
                <p className="text-sm">
                  <b className="tabular-nums">{Math.round((health.pct ?? 0) * 100)}% da renda</b> foi para o crédito ({BR(health.spentCents)} de {BR(health.incomeCents)}).{' '}
                  {health.overCents > 0 ? (
                    <span className="font-semibold text-danger">Passou {BR(health.overCents)} do teto de 30% ({BR(health.safeCents ?? 0)}).</span>
                  ) : (
                    <span className="text-[#3f5a12] dark:text-[#c8f169]">
                      Ainda cabem {BR(health.roomCents ?? 0)}
                      {health.roomPerDayCents ? ` (${BR(health.roomPerDayCents)}/dia)` : ''} até o fim do mês.
                    </span>
                  )}
                </p>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-2xl bg-background p-2.5">
                    <dt className="text-muted">Parcelas no próximo mês</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">
                      {BR(health.nextMonthInstallmentsCents)}
                      {health.nextMonthPct != null ? <span className="font-normal text-muted"> · {Math.round(health.nextMonthPct * 100)}% da renda</span> : null}
                    </dd>
                  </div>
                  <div className="rounded-2xl bg-background p-2.5">
                    <dt className="text-muted">Limite usado (com parcelas)</dt>
                    <dd className={cn('mt-0.5 font-semibold tabular-nums', (health.limitUsePct ?? 0) > 0.3 && 'text-danger')}>
                      {health.limitUsePct != null ? `${Math.round(health.limitUsePct * 100)}%` : '—'}
                      <span className="font-normal text-muted"> · ideal até 30%</span>
                    </dd>
                  </div>
                </dl>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                Renda do mês: {incomeCents ? BR(incomeCents) : '—'} {health.incomeSource === 'manual' ? '(você definiu)' : health.incomeSource === 'extrato' ? '(salários no extrato)' : ''}
              </span>
              {editIncome ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void saveIncome()
                  }}
                >
                  <input
                    inputMode="decimal"
                    value={incomeInput}
                    onChange={(e) => setIncomeInput(e.target.value)}
                    placeholder="Ex.: 5.300,00 (vazio = do extrato)"
                    className="h-8 w-44 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                  />
                  <button type="submit" className="font-semibold underline">
                    Salvar
                  </button>
                </form>
              ) : (
                <button type="button" className="font-semibold underline" onClick={() => setEditIncome(true)}>
                  Ajustar
                </button>
              )}
            </div>
            <p className="text-[11px] text-muted">
              Referências: faturas e dívidas até 30% da renda líquida; limite usado até 30%; nunca pagar só o mínimo (o rotativo passa de 400% ao ano).
            </p>
          </Panel>

          {ledger.length ? (
            <Panel icon={Wallet} title="Faturas: todos os cartões">
              <ul className="space-y-2">
                {[...ledger.map((l) => ({ ...l, total: false })), {
                  card: 'Todos os cartões',
                  boughtCents: ledger.reduce((s, l) => s + l.boughtCents, 0),
                  installmentsCents: ledger.reduce((s, l) => s + l.installmentsCents, 0),
                  paidCents: ledger.reduce((s, l) => s + l.paidCents, 0),
                  toPayCents: ledger.some((l) => l.toPayCents != null) ? ledger.reduce((s, l) => s + (l.toPayCents ?? 0), 0) : null,
                  futureCents: ledger.reduce((s, l) => s + l.futureCents, 0),
                  total: true,
                }].map((l) => (
                  <li key={l.card} className={cn('rounded-2xl p-3', l.total ? 'bg-ink text-[#f2f3ee]' : 'bg-background')}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                        {!l.total ? <i className="size-2 rounded-full" style={{ background: colorOf(l.card) }} /> : null}
                        {l.card}
                      </span>
                      <span className="text-right">
                        <span className={cn('block text-[11px]', l.total ? 'text-[#b9bdb4]' : 'text-muted')}>comprou no mês</span>
                        <span className="text-base font-semibold tabular-nums">{BR(l.boughtCents)}</span>
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      {([
                        ['Parcelas do mês', l.installmentsCents],
                        ['Fatura paga', l.paidCents || null],
                        ['A pagar', l.toPayCents],
                        ['Parcelas futuras', l.futureCents || null],
                      ] as [string, number | null][]).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2">
                          <dt className={l.total ? 'text-[#b9bdb4]' : 'text-muted'}>{k}</dt>
                          <dd className="tabular-nums">{v != null ? BR0(v) : '—'}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted">
                Comprou = compras do mês pela data (parcelas incluídas). Pagou = faturas pagas no mês, inclusive por Pix. A pagar = fatura fechada + aberta
                informadas pelo banco (Open Finance). O pagamento de fatura não entra como gasto: as compras já contam uma a uma.
              </p>
            </Panel>
          ) : null}

          <AdvicePanel input={adviceInput} cacheKey={`credito:${cur}`} title="Conselhos para o seu crédito" />
        </>
      ) : null}

      {loading ? <ListSkeleton rows={4} /> : null}

      {!loading && !rows.length ? (
        <p className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
          Nenhuma compra de cartão salva ainda. Importe as faturas ou traga tudo do Open Finance.
        </p>
      ) : null}

      {!loading && rows.length ? (
        <>
          {/* ritmo */}
          <Panel icon={TrendingUp} title={isCurrent ? 'Ritmo do mês' : 'Como o mês andou'}>
            <div className="h-44" aria-label="Gasto acumulado por dia, este mês e o anterior">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pace} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={ct.grid} strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="dia" tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} interval={6} />
                  <YAxis tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <Tooltip contentStyle={tooltipStyle} formatter={brlTip} labelFormatter={(l) => `Dia ${l}`} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line name={`Mês anterior (${monthLabel(shiftMonth(cur, -1), 'LLL')})`} type="monotone" dataKey="anterior" stroke="var(--series-muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                  <Line name="Este mês" type="monotone" dataKey="este" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {isCurrent && delta != null ? (
              <p className="text-xs text-muted">
                Até hoje você gastou {BR(curCum[todayIdx] ?? 0)} no crédito; no mesmo ponto do mês passado eram {BR(prevSameDay)}.
              </p>
            ) : null}
          </Panel>

          {/* categorias */}
          <Panel icon={Layers} title="Para onde foi" right={<span className="text-xs text-muted">toque para detalhar</span>}>
            <ul className="space-y-1">
              {a.byCategory.map((c) => {
                const open = openCat === c.id
                return (
                  <li key={c.id} className="rounded-2xl transition-colors hover:bg-background">
                    <button type="button" className="w-full p-2 text-left" onClick={() => setOpenCat(open ? null : c.id)} aria-expanded={open}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                        <span className="text-xs text-muted tabular-nums">{Math.round((c.cents / Math.max(1, a.totalCents)) * 100)}%</span>
                        <span className="w-24 text-right font-semibold tabular-nums">{BR(c.cents)}</span>
                        <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} />
                      </div>
                      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-border/60">
                        <span className="block h-full rounded-full bg-[var(--series-1)]" style={{ width: `${(c.cents / maxCat) * 100}%` }} />
                      </span>
                    </button>
                    {open ? (
                      <div className="space-y-2 px-2 pb-2.5 text-xs">
                        {c.children.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {c.children.map((s) => (
                              <span key={s.name} className="rounded-full bg-background px-2 py-1">
                                {s.name} · <b>{BR0(s.cents)}</b>
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <ul className="space-y-0.5 text-muted">
                          {c.merchants.map((m) => (
                            <li key={m.name} className="flex justify-between gap-2">
                              <span className="truncate">
                                {m.name}
                                {m.count > 1 ? ` · ${m.count}×` : ''}
                              </span>
                              <span className="tabular-nums text-foreground">{BR(m.cents)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>

          {/* à vista × parcelado */}
          <Panel icon={ReceiptText} title="À vista × parcelado">
            <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`Parcelas ${Math.round(instShare * 100)}% do gasto`}>
              <span className="bg-[var(--series-1)]" style={{ width: `${(1 - instShare) * 100}%` }} />
              <span className="bg-[var(--series-4)]" style={{ width: `${instShare * 100}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-2xl bg-background p-2.5">
                <p className="flex items-center gap-1.5 text-muted">
                  <i className="size-2 rounded-full bg-[var(--series-1)]" /> À vista
                </p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">{BR(a.cashCents)}</p>
              </div>
              <div className="rounded-2xl bg-background p-2.5">
                <p className="flex items-center gap-1.5 text-muted">
                  <i className="size-2 rounded-full bg-[var(--series-4)]" /> Parcelas do mês
                </p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">{BR(a.installmentsCents)}</p>
              </div>
            </div>
            {a.newInstallments.count ? (
              <div className="rounded-2xl border border-border p-2.5 text-xs">
                <p className="font-semibold">
                  {a.newInstallments.count} compra(s) parcelada(s) nova(s) neste mês · comprometem {BR(a.newInstallments.commitmentCents)} no total
                </p>
                <ul className="mt-1 space-y-0.5 text-muted">
                  {a.newInstallments.items.slice(0, 5).map((x, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{x.name}</span>
                      <span className="tabular-nums">
                        {x.of}× {BR(x.cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          {/* histórico por cartão */}
          <Panel icon={CreditCard} title="Últimos 6 meses">
            <div className="h-52" aria-label="Gasto no crédito por mês e por cartão">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={ct.grid} vertical={false} />
                  <XAxis dataKey="mes" tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <Tooltip contentStyle={tooltipStyle} formatter={brlTip} cursor={{ fill: ct.accentSoft }} />
                  {(card ? [card] : cards).length > 1 ? <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} /> : null}
                  {(card ? [card] : cards).map((c, i, arr) => (
                    <Bar
                      key={c}
                      dataKey={c}
                      stackId="a"
                      fill={colorOf(c)}
                      stroke={ct.tooltipBg}
                      strokeWidth={1}
                      radius={i === arr.length - 1 ? [4, 4, 0, 0] : 0}
                      maxBarSize={36}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* onde mais gastou */}
          <Panel icon={Store} title="Onde mais gastou">
            <ol className="space-y-1.5 text-sm">
              {a.topMerchants.map((m, i) => (
                <li key={m.name} className="flex items-center gap-2.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-semibold text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {m.name}
                    {m.count > 1 ? <span className="text-xs text-muted"> · {m.count} compras</span> : null}
                  </span>
                  <span className="tabular-nums font-semibold">{BR(m.cents)}</span>
                </li>
              ))}
            </ol>
            {a.biggest.length ? (
              <div className="border-t border-border pt-2.5">
                <p className="mb-1 text-xs font-semibold text-muted">Maiores compras</p>
                <ul className="space-y-0.5 text-xs">
                  {a.biggest.map((t) => {
                    const i = installmentOf(t.description_raw)
                    return (
                      <li key={t.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {t.date.slice(8, 10)}/{t.date.slice(5, 7)} · {t.description_raw.replace(/\s*·.*$/, '').replace(/\s*\(parcela.*\)$/i, '')}
                          <span className="text-muted">
                            {' '}
                            · {cardName(t)}
                            {i ? ` · ${i.of}×` : ''}
                          </span>
                        </span>
                        <span className="tabular-nums">{BR(t.amount_cents)}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
          </Panel>

          {/* limite e próximas faturas */}
          <OfCardsPanel compact />
          <FutureInstallments txs={card ? rows.filter((t) => cardName(t) === card) : rows} today={periods.today} />
        </>
      ) : null}
    </div>
  )
}
