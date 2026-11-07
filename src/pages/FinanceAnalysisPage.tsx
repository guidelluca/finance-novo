import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FinanceInsightsCard } from '@/components/finance/FinanceInsightsCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/contexts/AuthContext'
import { useFinanceAiContext } from '@/contexts/FinanceAiContext'
import {
  aggregateByMonth,
  buildFinanceContextPack,
  fetchAllTransactionSummary,
  type SummaryRow,
} from '@/lib/financeSummary'
import { formatBRLFromCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import type { Category, Transaction } from '@/types/database'
import { cn } from '@/lib/utils'

type Tx = Transaction & { categories: Pick<Category, 'name'> | null }

export function FinanceAnalysisPage() {
  const { user } = useAuth()
  const { setFinanceContextPack } = useFinanceAiContext()
  const [tab, setTab] = useState<'overview' | 'month'>('overview')
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([])
  const [loadingSummary, setLoadingSummary] = useState(true)
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [txs, setTxs] = useState<Tx[]>([])
  const [loadingMonth, setLoadingMonth] = useState(false)
  const [monthlyNet, setMonthlyNet] = useState<{ key: string; label: string; net: number }[]>([])
  const [monthlyFlow, setMonthlyFlow] = useState<
    { key: string; label: string; income: number; expense: number }[]
  >([])

  const loadSummary = useCallback(() => {
    if (!user) return
    void (async () => {
      setLoadingSummary(true)
      try {
        const rows = await fetchAllTransactionSummary(user.id)
        setSummaryRows(rows)
      } catch {
        setSummaryRows([])
      } finally {
        setLoadingSummary(false)
      }
    })()
  }, [user])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  const allMonthsSeries = useMemo(() => aggregateByMonth(summaryRows), [summaryRows])
  const monthKeysWithData = useMemo(() => allMonthsSeries.map((m) => m.key), [allMonthsSeries])

  const overviewTotals = useMemo(() => {
    let income = 0
    let expense = 0
    for (const t of summaryRows) {
      if (t.kind === 'credit') income += t.amount_cents
      else expense += t.amount_cents
    }
    return { income, expense, net: income - expense }
  }, [summaryRows])

  useEffect(() => {
    if (!user) return
    const start = format(startOfMonth(month), 'yyyy-MM-dd')
    const end = format(endOfMonth(month), 'yyyy-MM-dd')
    void (async () => {
      setLoadingMonth(true)
      const { data, error } = await supabase
        .from('transactions')
        .select('*, categories(name)')
        .eq('user_id', user.id)
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: false })
      if (!error && data) setTxs(data as Tx[])
      setLoadingMonth(false)
    })()
  }, [user, month])

  useEffect(() => {
    if (!user) return
    const months = [5, 4, 3, 2, 1, 0].map((i) => startOfMonth(subMonths(month, i)))
    const from = format(months[0]!, 'yyyy-MM-dd')
    const to = format(endOfMonth(months[months.length - 1]!), 'yyyy-MM-dd')
    void (async () => {
      const { data } = await supabase
        .from('transactions')
        .select('date, amount_cents, kind')
        .eq('user_id', user.id)
        .gte('date', from)
        .lte('date', to)
      const netBy = new Map<string, number>()
      const flowBy = new Map<string, { income: number; expense: number }>()
      for (const t of data ?? []) {
        const k = t.date.slice(0, 7)
        const s = t.kind === 'credit' ? t.amount_cents : -t.amount_cents
        netBy.set(k, (netBy.get(k) ?? 0) + s)
        const f = flowBy.get(k) ?? { income: 0, expense: 0 }
        if (t.kind === 'credit') f.income += t.amount_cents
        else f.expense += t.amount_cents
        flowBy.set(k, f)
      }
      setMonthlyNet(
        months.map((m) => {
          const key = format(m, 'yyyy-MM')
          return {
            key,
            label: format(m, 'MMM', { locale: ptBR }),
            net: netBy.get(key) ?? 0,
          }
        }),
      )
      setMonthlyFlow(
        months.map((m) => {
          const key = format(m, 'yyyy-MM')
          const f = flowBy.get(key) ?? { income: 0, expense: 0 }
          return { key, label: format(m, 'MMM', { locale: ptBR }), income: f.income, expense: f.expense }
        }),
      )
    })()
  }, [user, month])

  const monthSelectValue = format(month, 'yyyy-MM')

  const shiftMonthWithData = (dir: -1 | 1) => {
    if (monthKeysWithData.length === 0) {
      setMonth((m) => subMonths(m, -dir))
      return
    }
    let idx = monthKeysWithData.indexOf(monthSelectValue)
    if (idx < 0) {
      idx = dir === -1 ? monthKeysWithData.length - 1 : 0
    } else {
      idx += dir
      if (idx < 0 || idx >= monthKeysWithData.length) return
    }
    const key = monthKeysWithData[idx]
    if (key) setMonth(startOfMonth(parseISO(`${key}-01`)))
  }

  useEffect(() => {
    if (monthKeysWithData.length === 0) return
    const k = format(month, 'yyyy-MM')
    if (!monthKeysWithData.includes(k)) {
      const last = monthKeysWithData[monthKeysWithData.length - 1]!
      setMonth(startOfMonth(parseISO(`${last}-01`)))
    }
  }, [monthKeysWithData, month])

  const stats = useMemo(() => {
    let income = 0
    let expense = 0
    for (const t of txs) {
      if (t.kind === 'credit') income += t.amount_cents
      else expense += t.amount_cents
    }
    return { income, expense, net: income - expense }
  }, [txs])

  const pieData = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of txs) {
      if (t.kind === 'credit') continue
      const label = t.categories?.name ?? 'Sem categoria'
      map.set(label, (map.get(label) ?? 0) + t.amount_cents)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [txs])

  useEffect(() => {
    if (!user || loadingSummary) return
    const lastMonths = allMonthsSeries.slice(-10).map((m) => ({
      label: m.labelFull,
      income: m.income,
      expense: m.expense,
      net: m.net,
    }))
    const focus =
      tab === 'month'
        ? {
            label: format(month, 'MMMM yyyy', { locale: ptBR }),
            income: stats.income,
            expense: stats.expense,
            net: stats.net,
            categories: pieData.map((p) => ({ name: p.name, expenseCents: p.value })),
          }
        : undefined
    setFinanceContextPack(
      buildFinanceContextPack({
        overview: {
          income: overviewTotals.income,
          expense: overviewTotals.expense,
          net: overviewTotals.net,
          monthCount: allMonthsSeries.length,
        },
        lastMonths,
        focusMonth: focus,
      }),
    )
  }, [
    user,
    loadingSummary,
    allMonthsSeries,
    overviewTotals,
    tab,
    month,
    stats,
    pieData,
    setFinanceContextPack,
  ])

  if (!user) return null

  return (
    <div className="space-y-6 pb-24">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Análise financeira</h1>
        <p className="text-sm text-muted">
          Relatórios com IA para o período completo ou para um mês. O botão flutuante usa o mesmo resumo ao conversar.
        </p>
      </header>

      <div className="flex rounded-xl border border-border bg-surface-elevated/50 p-1">
        <button
          type="button"
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-xs font-medium sm:text-sm',
            tab === 'overview' ? 'bg-accent text-[#04120c] shadow-sm' : 'text-muted',
          )}
          onClick={() => setTab('overview')}
        >
          Visão geral
        </button>
        <button
          type="button"
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-xs font-medium sm:text-sm',
            tab === 'month' ? 'bg-accent text-[#04120c] shadow-sm' : 'text-muted',
          )}
          onClick={() => setTab('month')}
        >
          Um mês
        </button>
      </div>

      {tab === 'overview' ? (
        loadingSummary && summaryRows.length === 0 ? (
          <p className="text-muted">A carregar…</p>
        ) : allMonthsSeries.length === 0 ? (
          <p className="text-sm text-muted">Sem lançamentos. Importa ou cria movimentos no extrato.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase text-muted">Entradas (total)</CardTitle>
                </CardHeader>
                <CardContent className="font-mono text-lg text-accent tabular-nums">
                  {formatBRLFromCents(overviewTotals.income)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase text-muted">Saídas (total)</CardTitle>
                </CardHeader>
                <CardContent className="font-mono text-lg text-danger tabular-nums">
                  {formatBRLFromCents(overviewTotals.expense)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase text-muted">Saldo acumulado</CardTitle>
                </CardHeader>
                <CardContent
                  className={cn(
                    'font-mono text-lg font-semibold tabular-nums',
                    overviewTotals.net >= 0 ? 'text-accent' : 'text-danger',
                  )}
                >
                  {formatBRLFromCents(Math.abs(overviewTotals.net))}
                </CardContent>
              </Card>
            </div>
            <FinanceInsightsCard
              buildInput={() => ({
                locale: 'pt-BR',
                mode: 'overview',
                totals: {
                  incomeCents: overviewTotals.income,
                  expenseCents: overviewTotals.expense,
                  netCents: overviewTotals.net,
                },
                monthlySeries: allMonthsSeries.slice(-14).map((m) => ({
                  label: m.labelFull,
                  incomeCents: m.income,
                  expenseCents: m.expense,
                  netCents: m.net,
                })),
                savingsRateHint:
                  overviewTotals.income > 0
                    ? `Indicador bruto no período: líquido ÷ entradas ≈ ${((overviewTotals.net / overviewTotals.income) * 100).toFixed(1)}%.`
                    : undefined,
              })}
            />
          </>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-elevated px-3 py-2 text-sm"
              onClick={() => shiftMonthWithData(-1)}
              disabled={monthKeysWithData.length > 0 && monthKeysWithData.indexOf(monthSelectValue) <= 0}
            >
              ‹
            </button>
            {monthKeysWithData.length > 0 ? (
              <select
                className="min-w-[11rem] rounded-xl border border-border bg-surface-elevated px-3 py-2 text-sm capitalize"
                value={
                  monthKeysWithData.includes(monthSelectValue)
                    ? monthSelectValue
                    : monthKeysWithData[monthKeysWithData.length - 1]
                }
                onChange={(e) =>
                  setMonth(startOfMonth(parseISO(`${e.target.value}-01`)))
                }
              >
                {monthKeysWithData.map((k) => {
                  const d = startOfMonth(parseISO(`${k}-01`))
                  return (
                    <option key={k} value={k}>
                      {format(d, 'MMMM yyyy', { locale: ptBR })}
                    </option>
                  )
                })}
              </select>
            ) : (
              <span className="text-sm capitalize">
                {format(month, 'MMMM yyyy', { locale: ptBR })}
              </span>
            )}
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-elevated px-3 py-2 text-sm"
              onClick={() => shiftMonthWithData(1)}
              disabled={
                monthKeysWithData.length > 0 &&
                monthKeysWithData.indexOf(monthSelectValue) >= monthKeysWithData.length - 1
              }
            >
              ›
            </button>
          </div>

          {loadingMonth && txs.length === 0 ? (
            <p className="text-muted">A carregar mês…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs uppercase text-muted">Entradas</CardTitle>
                  </CardHeader>
                  <CardContent className="font-mono text-lg text-accent tabular-nums">
                    {formatBRLFromCents(stats.income)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs uppercase text-muted">Saídas</CardTitle>
                  </CardHeader>
                  <CardContent className="font-mono text-lg text-danger tabular-nums">
                    {formatBRLFromCents(stats.expense)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs uppercase text-muted">Saldo do mês</CardTitle>
                  </CardHeader>
                  <CardContent
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      stats.net >= 0 ? 'text-accent' : 'text-danger',
                    )}
                  >
                    {formatBRLFromCents(Math.abs(stats.net))}
                  </CardContent>
                </Card>
              </div>
              <FinanceInsightsCard
                buildInput={() => ({
                  locale: 'pt-BR',
                  mode: 'month',
                  monthLabel: format(month, 'MMMM yyyy', { locale: ptBR }),
                  totals: {
                    incomeCents: stats.income,
                    expenseCents: stats.expense,
                    netCents: stats.net,
                  },
                  categoryBreakdown: pieData.map((p) => ({ name: p.name, expenseCents: p.value })),
                  monthlySeries: monthlyNet.map((m, i) => ({
                    label: m.label,
                    incomeCents: monthlyFlow[i]?.income ?? 0,
                    expenseCents: monthlyFlow[i]?.expense ?? 0,
                    netCents: m.net,
                  })),
                  savingsRateHint:
                    stats.income > 0
                      ? `Indicador bruto no mês: líquido ÷ entradas ≈ ${((stats.net / stats.income) * 100).toFixed(1)}%.`
                      : undefined,
                })}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
