import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, ClipboardCheck, Plus, Sparkles, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { HomeDashboard } from '@/components/finance/HomeDashboard'
import { useCoverage } from '@/hooks/useCoverage'
import { readHouse } from '@/lib/house'
import { useMonthData } from '@/hooks/useMonthData'
import { usePeriods } from '@/hooks/usePeriods'
import { effectiveTotal, readBudgets } from '@/lib/budgets'
import { formatBRLFromCents } from '@/lib/currency'
import { consolidateMonth, shiftMonth } from '@/lib/monthConsolidation'
import { detectRecurring } from '@/lib/recurring'
import { cn } from '@/lib/utils'

/** Cores dos ícones de categoria (tons claros + texto escuro, legíveis nos dois temas) */
const TILES = [
  ['#E7F0D5', '#3F5A12'],
  ['#FCE6D6', '#9A3412'],
  ['#DDE6FB', '#1E40AF'],
  ['#EDE3FA', '#6B21A8'],
  ['#DDF3E6', '#166534'],
  ['#F1EFE6', '#44403C'],
] as const
export function tileColors(name: string | null | undefined): { background: string; color: string } {
  const s = name ?? '?'
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const [bg, fg] = TILES[h % TILES.length]!
  return { background: bg, color: fg }
}

function splitMoney(cents: number): [string, string] {
  const s = formatBRLFromCents(Math.abs(cents))
  const i = s.lastIndexOf(',')
  return i > 0 ? [s.slice(0, i), s.slice(i)] : [s, '']
}

function relDay(iso: string, today: string): string {
  if (iso === today) return 'hoje'
  const d = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 86_400_000
  if (d === 1) return 'ontem'
  return format(parseISO(iso), "d MMM", { locale: ptBR })
}

export function HomePage() {
  const { user } = useAuth()
  const periods = usePeriods()
  const today = periods.today
  const [month, setMonth] = useState(() => periods.current)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setMonth(periods.current)
  }, [periods.current, touched])
  // fechamento do mês anterior: avisa até todos os extratos estarem importados
  const closingMonth = shiftMonth(periods.current, -1)
  const closing = useCoverage(closingMonth)
  const closingMissing = closing.coverage.filter((c) => c.status === 'falta' || c.status === 'parcial')
  const { loading, error, result, monthTxs, history, range, dismissed } = useMonthData(month)
  const budgets = readBudgets(user)

  const isCurrent = month === periods.current
  // dias do mês financeiro (ex.: 29/10 a 26/11); refDay = posição de hoje nele (1 = 1.º dia)
  const dayIdx = (iso: string) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000)
  const daysInMonth = dayIdx(range.end) + 1
  const refDay = isCurrent ? Math.min(daysInMonth, dayIdx(today) + 1) : daysInMonth
  const todayDay = Number(today.slice(8))

  const { daily, maxDay, spentSoFar } = useMemo(() => {
    const d = Array.from({ length: daysInMonth }, () => 0)
    for (const t of result.included) {
      const i = dayIdx(t.date)
      if (t.kind === 'debit' && i >= 0 && i < d.length) d[i] = (d[i] ?? 0) + t.amountCents
    }
    const so = d.slice(0, refDay).reduce((s, v) => s + v, 0)
    return { daily: d, maxDay: Math.max(1, ...d), spentSoFar: so }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, daysInMonth, refDay, range.start])

  // gasto até o mesmo dia no mês anterior (consolidado, sem repetições)
  const prevSoFar = useMemo(() => {
    const prev = shiftMonth(month, -1)
    const prevStart = periods.rangeOf(prev).start
    const prevTx = history.filter((t) => periods.periodOf(t.date) === prev)
    if (prevTx.length === 0) return null
    const r = consolidateMonth(prev, prevTx, history.filter((t) => periods.periodOf(t.date) < prev), today, new Set(), (user?.user_metadata?.owner_name as string | undefined) ?? null, periods.periodOf, readHouse(user))
    const offset = (iso: string) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${prevStart}T12:00:00Z`)) / 86_400_000)
    return r.included
      .filter((t) => t.kind === 'debit' && offset(t.date) < refDay)
      .reduce((s, t) => s + t.amountCents, 0)
  }, [history, month, refDay, today, periods])
  const delta = prevSoFar ? spentSoFar / prevSoFar - 1 : null

  const recurring = useMemo(
    () => detectRecurring(month, monthTxs, history, (user?.user_metadata?.owner_name as string | undefined) ?? null, readHouse(user)),
    [month, monthTxs, history, user],
  )
  const upcoming = recurring
    .filter((r) => !r.paidThisMonth && (!isCurrent || r.day >= todayDay))
    .slice(0, 3)
  const upcomingTotal = upcoming.reduce((s, r) => s + r.amountCents, 0)

  const spentByCat = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of result.byCategory) if (g.categoryId) m.set(g.categoryId, g.totalCents)
    return m
  }, [result])
  const budgetRows = Object.entries(budgets.byCategory)
    .map(([id, limit]) => ({
      id,
      name: result.byCategory.find((g) => g.categoryId === id)?.name ?? '',
      limit,
      spent: spentByCat.get(id) ?? 0,
    }))
    .filter((r) => r.name || r.spent)
    .sort((a, b) => b.spent / b.limit - a.spent / a.limit)
    .slice(0, 3)
  const topCats = result.byCategory.filter((g) => g.categoryId).slice(0, 3)

  const insight =
    result.issues.find((i) => i.severity !== 'baixa' && i.type !== 'sem_categoria') ??
    result.issues.find((i) => i.type !== 'sem_categoria') ??
    null

  const recent = [...result.included].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 4)
  const [whole, cents] = splitMoney(result.totals.netCents)
  const monthName = format(parseISO(`${month}-01`), 'LLLL', { locale: ptBR })

  return (
    <div className="space-y-3.5 pb-24">
      <div className="flex items-center justify-center gap-1">
        <button type="button" aria-label="Mês anterior" onClick={() => {
            setTouched(true)
            setMonth((m) => shiftMonth(m, -1))
          }} className="flex size-11 items-center justify-center rounded-xl hover:bg-surface">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-[120px] text-center">
          <p className="font-display text-xl font-semibold first-letter:uppercase">{monthName}</p>
          <p className="text-xs font-medium text-muted">
            {range.start.slice(8)}/{range.start.slice(5, 7)} – {range.end.slice(8)}/{range.end.slice(5, 7)}
          </p>
        </div>
        <button type="button" aria-label="Próximo mês" onClick={() => {
            setTouched(true)
            setMonth((m) => shiftMonth(m, 1))
          }} className="flex size-11 items-center justify-center rounded-xl hover:bg-surface">
          <ChevronRight className="size-5" />
        </button>
      </div>

      {error ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}

      {/* Cartão escuro */}
      <section className="space-y-[18px] rounded-[28px] bg-ink p-[22px] text-[#f2f3ee]" aria-label="Resumo do mês">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="text-[13px] text-[#b9bdb4]">{result.totals.netCents >= 0 ? 'Sobrou este mês' : 'Faltou este mês'}</p>
            <p className="font-display text-[42px] font-bold leading-none tracking-[-1px]">
              {loading ? '…' : (
                <>
                  {result.totals.netCents < 0 ? '−' : ''}
                  {whole}
                  <span className="text-2xl text-[#b9bdb4]">{cents}</span>
                </>
              )}
            </p>
          </div>
          {delta != null && Number.isFinite(delta) ? (
            <span
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1.5 text-xs font-semibold text-ink',
                delta <= 0 ? 'bg-lime' : 'bg-[#f28c6b]',
              )}
              title={`Gastos nos primeiros ${refDay} dias do mês financeiro, comparados com o mesmo trecho do mês anterior`}
            >
              {delta <= 0 ? '−' : '+'}
              {Math.abs(Math.round(delta * 100))}% gastos
            </span>
          ) : null}
        </div>
        <div className="flex h-14 items-end gap-[3px]" aria-hidden>
          {daily.map((v, i) => {
            const future = isCurrent && i + 1 > refDay
            const isToday = isCurrent && i + 1 === refDay
            return (
              <span
                key={i}
                className={cn(
                  'flex-1 rounded-[3px]',
                  future ? 'border border-dashed border-[#5e636b]' : isToday ? 'bg-lime' : 'bg-[#3a3e44]',
                )}
                style={{ height: future ? '15%' : `${Math.max(6, Math.round((v / maxDay) * 100))}%` }}
              />
            )
          })}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Link to={`/transactions?kind=credit&month=${month}`} className="rounded-2xl bg-[#23262b] px-3.5 py-3">
            <p className="text-xs text-[#b9bdb4]">Entrou</p>
            <p className="truncate text-[17px] font-semibold tabular-nums">{formatBRLFromCents(result.totals.incomeCents)}</p>
          </Link>
          <Link to={`/transactions?kind=debit&month=${month}`} className="rounded-2xl bg-[#23262b] px-3.5 py-3">
            <p className="text-xs text-[#b9bdb4]">Saiu</p>
            <p className="truncate text-[17px] font-semibold tabular-nums">{formatBRLFromCents(result.totals.expenseCents)}</p>
          </Link>
        </div>
      </section>

      {/* Fechamento do mês anterior */}
      {!closing.loading && (closingMissing.length > 0 || closing.quiet.pending > 0) ? (
        <Link to="/fechamento" className="flex items-start gap-3.5 rounded-3xl border border-[#f6d3bb] bg-[#fff4ec] p-4 text-[#7c2d12] dark:border-[#5a3622] dark:bg-[#2a1d15] dark:text-[#ffd9c2]">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/80 text-[#9a3412] dark:bg-black/20 dark:text-[#ffb38a]">
            <ClipboardCheck className="size-[18px]" strokeWidth={2} />
          </span>
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-semibold leading-snug">
              Fechamento de {format(parseISO(`${closingMonth}-01`), 'LLLL', { locale: ptBR })}: {closing.done} de {closing.total} contas completas
            </span>
            <span className="block text-[13px] leading-snug opacity-85">
              {closingMissing.length > 0
                ? `Falta${closingMissing.length > 1 ? 'm' : ''}: ${closingMissing.map((c) => c.account.name).join(', ')}. `
                : ''}
              {closing.quiet.pending > 0
                ? `${closing.quiet.pending} período(s) sem nenhum lançamento para você confirmar. `
                : ''}
              Toque para ver.
            </span>
          </span>
        </Link>
      ) : null}

      {/* Alerta inteligente */}
      {insight ? (
        <section className="flex items-start gap-3.5 rounded-3xl bg-[#e4ebfb] p-4 text-[#1a2a55] dark:bg-[#1c2a4a] dark:text-[#dfe7ff]">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#2f5bd3] text-white">
            <Sparkles className="size-[18px]" strokeWidth={2} />
          </span>
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-semibold leading-snug">{insight.title}</p>
            <p className="text-[13px] leading-snug opacity-80">{insight.detail}</p>
            <Link to="/mes" className="inline-flex min-h-9 items-center rounded-full bg-[#2f5bd3] px-3.5 text-[13px] font-semibold text-white">
              Revisar no mês{result.issues.length > 1 ? ` (${result.issues.length})` : ''}
            </Link>
          </div>
        </section>
      ) : null}

      {/* Atalhos */}
      <div className="grid grid-cols-3 gap-2.5">
        <Link to="/import" className="flex flex-col items-center gap-2 rounded-[18px] border border-border bg-surface px-2.5 py-3.5 text-[13px] font-medium">
          <Upload className="size-[22px]" strokeWidth={1.8} />
          Importar
        </Link>
        <Link to="/transactions?new=1" className="flex flex-col items-center gap-2 rounded-[18px] border border-border bg-surface px-2.5 py-3.5 text-[13px] font-medium">
          <Plus className="size-[22px]" strokeWidth={1.8} />
          Lançar
        </Link>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('finance:open-ai'))}
          className="flex flex-col items-center gap-2 rounded-[18px] border border-border bg-surface px-2.5 py-3.5 text-[13px] font-medium"
        >
          <Sparkles className="size-[22px]" strokeWidth={1.8} />
          Perguntar
        </button>
      </div>

      {/* Orçamento */}
      <section className="space-y-4 rounded-3xl border border-border bg-surface p-[18px]">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Orçamento</h2>
          <Link to="/orcamento" className="text-[13px] font-semibold text-[#2f5bd3] dark:text-[#8fb0ff]">
            {effectiveTotal(budgets) ? 'Ver tudo' : 'Definir limites'}
          </Link>
        </div>
        {(budgetRows.length ? budgetRows : topCats.map((g) => ({ id: g.key, name: g.name, limit: 0, spent: g.totalCents }))).map((r) => {
          const over = r.limit > 0 && r.spent > r.limit
          const pct = r.limit > 0 ? Math.min(100, Math.round((r.spent / r.limit) * 100)) : Math.round(((r.spent || 0) / Math.max(1, result.totals.expenseCents)) * 100)
          return (
            <div key={r.id} className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{r.name}</span>
                <span className={cn(over ? 'font-semibold text-danger' : 'text-muted')}>
                  {r.limit > 0
                    ? `${formatBRLFromCents(r.spent).replace(/,\d\d$/, '')} de ${formatBRLFromCents(r.limit).replace(/,\d\d$/, '').replace('R$ ', '')}`
                    : formatBRLFromCents(r.spent)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#eeefe9] dark:bg-[#2b2e34]">
                <div className={cn('h-2 rounded-full', over ? 'bg-danger' : 'bg-foreground')} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            </div>
          )
        })}
        {!budgetRows.length && !topCats.length ? <p className="text-sm text-muted">Nenhum gasto neste mês ainda.</p> : null}
      </section>

      {/* Próximas contas */}
      {upcoming.length ? (
        <section className="space-y-2.5">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-lg font-semibold">Próximas contas</h2>
            <span className="text-[13px] text-muted">{formatBRLFromCents(upcomingTotal).replace(/,\d\d$/, '')} a vencer</span>
          </div>
          <div className="flex gap-2.5">
            {upcoming.map((r) => (
              <div key={r.key} className="min-w-0 flex-1 space-y-1.5 rounded-[18px] border border-border bg-surface p-3">
                <p className={cn('text-xs font-semibold', isCurrent && r.day - todayDay <= 3 ? 'text-danger' : 'text-muted')}>Dia {r.day}</p>
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="text-[13px] text-muted">{formatBRLFromCents(r.amountCents)}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Painel com gráficos */}
      {!loading ? (
        <HomeDashboard
          month={month}
          result={result}
          monthTxs={monthTxs}
          history={history}
          periods={periods}
          range={range}
          isCurrent={isCurrent}
          refDay={refDay}
          dismissed={dismissed}
          today={today}
        />
      ) : null}

      {/* Recentes */}
      <section className="rounded-3xl border border-border bg-surface px-1.5 py-2">
        <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2.5">
          <h2 className="text-lg font-semibold">Recentes</h2>
          <Link to={`/transactions?month=${month}`} className="text-[13px] font-semibold text-[#2f5bd3] dark:text-[#8fb0ff]">
            Extrato
          </Link>
        </div>
        {recent.length === 0 ? <p className="px-3 pb-3 text-sm text-muted">{loading ? 'Carregando…' : 'Nada por aqui ainda.'}</p> : null}
        {recent.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl font-display text-[15px] font-bold" style={tileColors(t.categoryName)}>
              {(t.categoryName ?? t.merchant).charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.merchant}</p>
              <p className="truncate text-xs text-muted">
                {t.categoryName ?? 'Sem categoria'} · {relDay(t.date, today)}
              </p>
            </div>
            <span className={cn('shrink-0 text-sm font-semibold tabular-nums', t.kind === 'credit' && 'text-positive')}>
              {t.kind === 'credit' ? '+' : '−'}
              {formatBRLFromCents(t.amountCents)}
            </span>
          </div>
        ))}
      </section>

    </div>
  )
}
