import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { PieLabelRenderProps } from 'recharts'
import { ExpandableChartCard } from '@/components/charts/ExpandableChartCard'
import { CardsQuickOverview } from '@/components/finance/CardsQuickOverview'
import { MonthBudgetCard } from '@/components/finance/MonthBudgetCard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useFinanceAiContext } from '@/contexts/FinanceAiContext'
import { useChartTheme } from '@/hooks/useChartTheme'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import {
  aggregateByMonth,
  buildFinanceContextPack,
  fetchAllTransactionSummary,
  type SummaryRow,
} from '@/lib/financeSummary'
import { supabase } from '@/lib/supabase'
import type { Category, Transaction } from '@/types/database'
import { cn } from '@/lib/utils'

const COLORS_DARK = ['#10b981', '#34d399', '#6ee7b7', '#059669', '#047857', '#0d9488', '#14b8a6', '#2dd4bf']
const COLORS_LIGHT = ['#059669', '#10b981', '#047857', '#0d9488', '#0f766e', '#0f766e', '#14b8a6', '#2dd4bf']

type Tx = Transaction & { categories: Pick<Category, 'name'> | null }

function signedAmount(t: Transaction): number {
  return t.kind === 'credit' ? t.amount_cents : -t.amount_cents
}

function tooltipStyle(ct: ReturnType<typeof useChartTheme>) {
  return {
    background: ct.tooltipBg,
    border: `1px solid ${ct.tooltipBorder}`,
    borderRadius: 12,
    color: ct.tooltipColor,
  }
}

export function DashboardPage() {
  const ct = useChartTheme()
  const COLORS = ct.isDark ? COLORS_DARK : COLORS_LIGHT
  const { user } = useAuth()
  const navigate = useNavigate()
  const { setFinanceContextPack } = useFinanceAiContext()
  const [dashboardMode, setDashboardMode] = useState<'overview' | 'month'>('overview')
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [txs, setTxs] = useState<Tx[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingSummary, setLoadingSummary] = useState(true)
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([])
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

  const overviewCumulative = useMemo(() => {
    let run = 0
    return allMonthsSeries.map((m) => {
      run += m.net
      return { key: m.key, label: m.label, balance: run }
    })
  }, [allMonthsSeries])

  useEffect(() => {
    if (!user || dashboardMode !== 'month') return
    const start = format(startOfMonth(month), 'yyyy-MM-dd')
    const end = format(endOfMonth(month), 'yyyy-MM-dd')
    void (async () => {
      setLoading(true)
      const { data, error } = await supabase
        .from('transactions')
        .select('*, categories(name)')
        .eq('user_id', user.id)
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: false })
      if (!error && data) setTxs(data as Tx[])
      setLoading(false)
    })()
  }, [user, month, dashboardMode])

  useEffect(() => {
    if (!user || dashboardMode !== 'month') return
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
  }, [user, month, dashboardMode])

  const goToMonthKey = (key: string) => {
    setMonth(startOfMonth(parseISO(`${key}-01`)))
    setDashboardMode('month')
  }

  const monthSelectValue = format(month, 'yyyy-MM')

  const shiftMonth = (dir: -1 | 1) => {
    setMonth((m) => subMonths(m, -dir))
  }

  /**
   * Meses disponíveis no seletor: união dos meses COM dados + os últimos 12 meses
   * a partir de hoje (para permitir navegar por meses ainda vazios, como o atual).
   * Ordenado do mais antigo → mais recente.
   */
  const selectableMonthKeys = useMemo(() => {
    const set = new Set<string>(monthKeysWithData)
    const today = new Date()
    for (let i = 0; i < 12; i++) {
      set.add(format(subMonths(today, i), 'yyyy-MM'))
    }
    set.add(monthSelectValue)
    return Array.from(set).sort()
  }, [monthKeysWithData, monthSelectValue])

  const currentIdx = selectableMonthKeys.indexOf(monthSelectValue)

  const stats = useMemo(() => {
    let income = 0
    let expense = 0
    for (const t of txs) {
      if (t.kind === 'credit') income += t.amount_cents
      else expense += t.amount_cents
    }
    return { income, expense, net: income - expense }
  }, [txs])

  const currentMonthTotals = useMemo(() => {
    const today = new Date()
    const startIso = format(startOfMonth(today), 'yyyy-MM-dd')
    const endIso = format(endOfMonth(today), 'yyyy-MM-dd')
    let income = 0
    let expense = 0
    for (const row of summaryRows) {
      if (row.date < startIso || row.date > endIso) continue
      if (row.kind === 'credit') income += row.amount_cents
      else expense += row.amount_cents
    }
    return { income, expense }
  }, [summaryRows])

  const cumulativeBalance = useMemo(() => {
    let run = 0
    return monthlyNet.map((m) => {
      run += m.net
      return { label: m.label, balance: run, key: m.key }
    })
  }, [monthlyNet])

  const dailyDebits = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of txs) {
      if (t.kind !== 'debit') continue
      map.set(t.date, (map.get(t.date) ?? 0) + t.amount_cents)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({
        label: format(parseISO(date), 'dd/MM'),
        value,
      }))
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

  const pieExpenseTotal = useMemo(() => pieData.reduce((s, d) => s + d.value, 0), [pieData])

  const bankSpend = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of txs) {
      if (t.kind !== 'debit') continue
      const label = t.account?.trim() || 'Não identificado'
      map.set(label, (map.get(label) ?? 0) + t.amount_cents)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [txs])

  useEffect(() => {
    if (!user) return
    if (loadingSummary && summaryRows.length === 0) return
    const lastMonths = allMonthsSeries.slice(-10).map((m) => ({
      label: m.labelFull,
      income: m.income,
      expense: m.expense,
      net: m.net,
    }))
    const focus =
      dashboardMode === 'month'
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
    summaryRows.length,
    allMonthsSeries,
    overviewTotals,
    dashboardMode,
    month,
    stats.income,
    stats.expense,
    stats.net,
    pieData,
    setFinanceContextPack,
  ])

  if (!user) return null

  const analysisCta = (
    <Card className="border-accent/25 bg-accent-muted/25">
      <CardContent className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Análise com IA</p>
          <p className="text-xs text-muted">
            Página dedicada a relatórios e o botão flutuante para conversar.
          </p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link to="/analysis">Abrir análise</Link>
        </Button>
      </CardContent>
    </Card>
  )

  const modeToggle = (
    <div className="flex w-full max-w-md rounded-xl border border-border bg-surface-elevated/50 p-1">
      <button
        type="button"
        className={cn(
          'flex-1 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm',
          dashboardMode === 'overview'
            ? 'bg-accent text-[#04120c] shadow-sm'
            : 'text-muted hover:text-foreground',
        )}
        onClick={() => setDashboardMode('overview')}
      >
        Todos os meses
      </button>
      <button
        type="button"
        className={cn(
          'flex-1 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm',
          dashboardMode === 'month'
            ? 'bg-accent text-[#04120c] shadow-sm'
            : 'text-muted hover:text-foreground',
        )}
        onClick={() => setDashboardMode('month')}
      >
        Um mês
      </button>
    </div>
  )

  if (dashboardMode === 'overview') {
    if (loadingSummary && summaryRows.length === 0) {
      return (
        <div className="space-y-6 pb-24">
          <header className="space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Visão geral</h1>
            {modeToggle}
          </header>
          <p className="text-center text-muted">Carregando histórico…</p>
        </div>
      )
    }

    if (allMonthsSeries.length === 0) {
      return (
        <div className="space-y-6 pb-24">
          <header className="space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Visão geral</h1>
            {modeToggle}
          </header>
          <p className="text-center text-sm text-muted">
            Ainda não há lançamentos. Importe ou crie movimentos no extrato.
          </p>
        </div>
      )
    }

    const overviewFlow = allMonthsSeries.map((m) => ({
      key: m.key,
      label: m.label,
      income: m.income,
      expense: m.expense,
    }))
    const overviewNet = allMonthsSeries.map((m) => ({
      key: m.key,
      label: m.label,
      net: m.net,
    }))
    const tickAngle = allMonthsSeries.length > 10 ? -40 : 0
    const xHeight = allMonthsSeries.length > 10 ? 52 : 24

    return (
      <div className="space-y-8 pb-24">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Visão geral</h1>
          <p className="text-sm text-muted">
            {allMonthsSeries.length}{' '}
            {allMonthsSeries.length === 1 ? 'mês com lançamentos' : 'meses com lançamentos'} · totais de
            todo o período. Toque num mês no gráfico ou na lista para ver o detalhe desse mês.
          </p>
          {modeToggle}
        </header>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="min-w-0 pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">
                Entradas (total)
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0 pt-2">
              <p
                className="font-mono text-base tabular-nums leading-snug tracking-tight text-accent sm:text-lg md:text-xl"
                title={formatBRLFromCents(overviewTotals.income)}
              >
                {formatBRLFromCents(overviewTotals.income)}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="min-w-0 pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">
                Saídas (total)
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0 pt-2">
              <p
                className="font-mono text-base tabular-nums leading-snug tracking-tight text-danger sm:text-lg md:text-xl"
                title={formatBRLFromCents(overviewTotals.expense)}
              >
                {formatBRLFromCents(overviewTotals.expense)}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="min-w-0 pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">
                Saldo acumulado (total)
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0 pt-2">
              <p
                className={cn(
                  'font-mono text-lg font-semibold tabular-nums leading-snug tracking-tight sm:text-xl md:text-2xl',
                  overviewTotals.net >= 0 ? 'text-accent' : 'text-danger',
                )}
                title={formatBRLFromCents(Math.abs(overviewTotals.net))}
              >
                {formatBRLFromCents(Math.abs(overviewTotals.net))}
              </p>
              {overviewTotals.net < 0 ? (
                <p className="mt-1 text-xs font-normal text-muted">Déficit global no período</p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <MonthBudgetCard
          userId={user.id}
          month={new Date()}
          spentCents={currentMonthTotals.expense}
          incomeCents={currentMonthTotals.income || undefined}
        />

        <CardsQuickOverview userId={user.id} />

        {analysisCta}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ExpandableChartCard
            title="Entradas vs saídas por mês"
            subtitle="Cada mês com pelo menos um lançamento"
            size="lg"
            svgIdPrefix="ov-ivse"
            renderChart={(_suffix, { tall }) => {
              const bottom = tall ? xHeight + 12 : xHeight
              return (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={overviewFlow} margin={{ top: 8, right: 8, left: 0, bottom: bottom }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke={ct.axis}
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      angle={tickAngle}
                      textAnchor={tickAngle ? 'end' : 'middle'}
                      height={bottom}
                      interval={0}
                    />
                    <YAxis
                      stroke={ct.axis}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatBRLFromCents(Number(v))}
                      width={72}
                    />
                    <Tooltip
                      formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                      contentStyle={tooltipStyle(ct)}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="income"
                      name="Entradas"
                      fill={ct.emerald}
                      radius={[6, 6, 0, 0]}
                      maxBarSize={32}
                      cursor="pointer"
                      onClick={(_, idx) => {
                        const k = overviewFlow[idx]?.key
                        if (k) goToMonthKey(k)
                      }}
                    />
                    <Bar
                      dataKey="expense"
                      name="Saídas"
                      fill={ct.red}
                      radius={[6, 6, 0, 0]}
                      maxBarSize={32}
                      cursor="pointer"
                      onClick={(_, idx) => {
                        const k = overviewFlow[idx]?.key
                        if (k) goToMonthKey(k)
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )
            }}
          />

          <ExpandableChartCard
            title="Saldo acumulado"
            subtitle="Soma do resultado líquido mês a mês (só meses com dados)"
            size="lg"
            svgIdPrefix="ov-cum"
            renderChart={(suffix, { tall }) => {
              const bottom = tall ? xHeight + 12 : xHeight
              const gradId = `fillBalOv-${suffix}`
              return (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={overviewCumulative} margin={{ top: 8, right: 8, left: 0, bottom: bottom }}>
                    <defs>
                      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={ct.emerald} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={ct.emerald} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke={ct.axis}
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      angle={tickAngle}
                      textAnchor={tickAngle ? 'end' : 'middle'}
                      height={bottom}
                      interval={0}
                    />
                    <YAxis
                      stroke={ct.axis}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatBRLFromCents(Number(v))}
                      width={72}
                    />
                    <Tooltip
                      formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                      contentStyle={tooltipStyle(ct)}
                    />
                    <Area
                      type="monotone"
                      dataKey="balance"
                      name="Acumulado"
                      stroke={ct.emerald}
                      strokeWidth={2}
                      fill={`url(#${gradId})`}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )
            }}
          />
        </div>

        <ExpandableChartCard
          title="Resultado líquido por mês"
          subtitle="Entradas − saídas"
          size="lg"
          svgIdPrefix="ov-net"
          renderChart={(suffix, { tall }) => {
            const bottom = tall ? xHeight + 12 : xHeight
            return (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={overviewNet} margin={{ top: 8, right: 8, left: 0, bottom: bottom }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke={ct.axis}
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    angle={tickAngle}
                    textAnchor={tickAngle ? 'end' : 'middle'}
                    height={bottom}
                    interval={0}
                  />
                  <YAxis
                    stroke={ct.axis}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={80}
                    tickFormatter={(v) => formatBRLFromCents(Number(v))}
                  />
                  <Tooltip
                    formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                    contentStyle={tooltipStyle(ct)}
                  />
                  <Bar
                    dataKey="net"
                    name="Líquido"
                    radius={[6, 6, 0, 0]}
                    cursor="pointer"
                    onClick={(_, idx) => {
                      const k = overviewNet[idx]?.key
                      if (k) goToMonthKey(k)
                    }}
                  >
                    {overviewNet.map((e) => (
                      <Cell key={`${e.key}-${suffix}`} fill={e.net >= 0 ? ct.emerald : ct.red} opacity={0.88} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )
          }}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ir para o mês</CardTitle>
            <p className="text-xs text-muted">Abre o dashboard só desse mês</p>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {[...allMonthsSeries].reverse().map((m) => (
              <button
                key={m.key}
                type="button"
                className="rounded-xl border border-border bg-surface-elevated/70 px-3 py-2 text-left text-xs capitalize transition hover:border-accent/40 sm:text-sm"
                onClick={() => goToMonthKey(m.key)}
              >
                <span className="font-medium">{m.labelFull}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-muted tabular-nums sm:text-xs">
                  {formatBRLFromCents(m.net >= 0 ? m.net : -m.net)}
                  {m.net < 0 ? ' déficit' : ' saldo'}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loading && txs.length === 0) {
    return (
      <div className="space-y-6 pb-24">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Visão geral</h1>
          {modeToggle}
        </header>
        <p className="text-center text-muted">Carregando…</p>
      </div>
    )
  }

  return (
    <div className="space-y-8 pb-24">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Um mês</h1>
        <p className="text-sm text-muted">
          Detalhe de {format(month, 'MMMM yyyy', { locale: ptBR })} — gráficos de contexto mostram os 6
          meses até este.
        </p>
        {modeToggle}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-elevated/90 px-3 py-2 text-sm font-medium shadow-sm transition hover:border-accent/40 disabled:opacity-40"
              onClick={() => shiftMonth(-1)}
              aria-label="Mês anterior"
            >
              ‹
            </button>
            <select
              className="min-w-[11rem] rounded-xl border border-border bg-surface-elevated px-3 py-2 text-sm font-semibold capitalize"
              value={monthSelectValue}
              onChange={(e) => goToMonthKey(e.target.value)}
            >
              {selectableMonthKeys.map((k) => {
                const d = startOfMonth(parseISO(`${k}-01`))
                const hasData = monthKeysWithData.includes(k)
                return (
                  <option key={k} value={k}>
                    {format(d, 'MMMM yyyy', { locale: ptBR })}
                    {hasData ? '' : ' (vazio)'}
                  </option>
                )
              })}
            </select>
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-elevated/90 px-3 py-2 text-sm font-medium shadow-sm transition hover:border-accent/40 disabled:opacity-40"
              onClick={() => shiftMonth(1)}
              disabled={currentIdx >= 0 && currentIdx === selectableMonthKeys.length - 1}
              aria-label="Próximo mês"
            >
              ›
            </button>
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-elevated/90 px-3 py-2 text-xs font-medium shadow-sm transition hover:border-accent/40"
              onClick={() => setMonth(startOfMonth(new Date()))}
              aria-label="Ir para o mês atual"
            >
              Hoje
            </button>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Link
          to={`/transactions?kind=credit&month=${monthSelectValue}`}
          className="block min-w-0 rounded-2xl border border-border bg-surface-elevated/70 p-4 shadow-sm transition hover:border-emerald-400/40 hover:bg-surface-elevated"
          aria-label="Ver entradas do mês"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Entradas</p>
          <p
            className="mt-2 font-mono text-base tabular-nums leading-snug tracking-tight text-accent sm:text-lg md:text-xl"
            title={formatBRLFromCents(stats.income)}
          >
            {formatBRLFromCents(stats.income)}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wide text-muted/70">
            Toque para ver
          </p>
        </Link>
        <Link
          to={`/transactions?kind=debit&month=${monthSelectValue}`}
          className="block min-w-0 rounded-2xl border border-border bg-surface-elevated/70 p-4 shadow-sm transition hover:border-red-400/40 hover:bg-surface-elevated"
          aria-label="Ver saídas do mês"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Saídas</p>
          <p
            className="mt-2 font-mono text-base tabular-nums leading-snug tracking-tight text-danger sm:text-lg md:text-xl"
            title={formatBRLFromCents(stats.expense)}
          >
            {formatBRLFromCents(stats.expense)}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wide text-muted/70">
            Toque para ver
          </p>
        </Link>
        <Link
          to={`/transactions?month=${monthSelectValue}`}
          className="block min-w-0 rounded-2xl border border-border bg-surface-elevated/70 p-4 shadow-sm transition hover:border-accent/40 hover:bg-surface-elevated"
          aria-label="Ver todos os lançamentos do mês"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Saldo do mês</p>
          <p
            className={cn(
              'mt-2 font-mono text-lg font-semibold tabular-nums leading-snug tracking-tight sm:text-xl md:text-2xl',
              stats.net >= 0 ? 'text-accent' : 'text-danger',
            )}
            title={`${formatBRLFromCents(Math.abs(stats.net))}${stats.net < 0 ? ' (déficit)' : ''}`}
          >
            {formatBRLFromCents(Math.abs(stats.net))}
          </p>
          {stats.net < 0 ? (
            <p className="mt-1 text-xs font-normal text-muted">Déficit no mês</p>
          ) : (
            <p className="mt-1 text-[10px] uppercase tracking-wide text-muted/70">
              Toque para ver
            </p>
          )}
        </Link>
      </div>

      <MonthBudgetCard
        userId={user.id}
        month={month}
        spentCents={stats.expense}
        incomeCents={stats.income || undefined}
      />

      <CardsQuickOverview userId={user.id} />

      {analysisCta}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ExpandableChartCard
          title="Entradas vs saídas"
          subtitle="Últimos 6 meses · valores brutos"
          size="md"
          svgIdPrefix="mo-flow"
          renderChart={(suffix) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyFlow} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} key={suffix}>
                <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                <XAxis dataKey="label" stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} />
                <YAxis
                  stroke={ct.axis}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => formatBRLFromCents(Number(v))}
                  width={72}
                />
                <Tooltip
                  formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                  contentStyle={tooltipStyle(ct)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="income" name="Entradas" fill={ct.emerald} radius={[6, 6, 0, 0]} maxBarSize={28} />
                <Bar dataKey="expense" name="Saídas" fill={ct.red} radius={[6, 6, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          )}
        />

        <ExpandableChartCard
          title="Saldo acumulado"
          subtitle="Soma do resultado líquido mês a mês"
          size="md"
          svgIdPrefix="mo-cumul"
          renderChart={(suffix) => {
            const gradId = `fillBal-${suffix}`
            return (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={cumulativeBalance} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ct.emerald} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ct.emerald} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                  <XAxis dataKey="label" stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke={ct.axis}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatBRLFromCents(Number(v))}
                    width={72}
                  />
                  <Tooltip
                    formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                    contentStyle={tooltipStyle(ct)}
                  />
                  <Area
                    type="monotone"
                    dataKey="balance"
                    name="Acumulado"
                    stroke={ct.emerald}
                    strokeWidth={2}
                    fill={`url(#${gradId})`}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )
          }}
        />
      </div>

      {dailyDebits.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Despesas por dia</CardTitle>
            <p className="text-xs text-muted">Soma de débitos por data no mês selecionado</p>
          </CardHeader>
          <CardContent className="min-h-32">
            <p className="text-sm text-muted">Sem despesas neste mês.</p>
          </CardContent>
        </Card>
      ) : (
        <ExpandableChartCard
          title="Despesas por dia"
          subtitle="Soma de débitos por data no mês selecionado"
          size="md"
          svgIdPrefix="mo-daily"
          renderChart={(suffix, { tall }) => (
            <ResponsiveContainer width="100%" height="100%" key={suffix}>
              <BarChart
                data={dailyDebits}
                margin={{ top: 8, right: 8, left: 0, bottom: tall ? 56 : 48 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke={ct.axis}
                  fontSize={10}
                  interval={0}
                  angle={-32}
                  textAnchor="end"
                  height={tall ? 56 : 48}
                />
                <YAxis
                  stroke={ct.axis}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => formatBRLFromCents(Number(v))}
                  width={72}
                />
                <Tooltip
                  formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                  contentStyle={tooltipStyle(ct)}
                />
                <Bar dataKey="value" name="Despesas" fill={ct.red} radius={[4, 4, 0, 0]} opacity={0.9} />
              </BarChart>
            </ResponsiveContainer>
          )}
        />
      )}

      {bankSpend.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gastos por banco</CardTitle>
            <p className="text-xs text-muted">
              Débitos no mês por origem da importação. Manuais em “Não identificado”.
            </p>
          </CardHeader>
          <CardContent className="min-h-32">
            <p className="text-sm text-muted">Sem despesas ou sem banco associado.</p>
          </CardContent>
        </Card>
      ) : (
        <ExpandableChartCard
          title="Gastos por banco"
          subtitle='Débitos no mês por origem da importação. Manuais em "Não identificado".'
          size="md"
          svgIdPrefix="mo-bank"
          renderChart={(suffix) => (
            <ResponsiveContainer width="100%" height="100%" key={suffix}>
              <BarChart layout="vertical" data={bankSpend} margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} horizontal={false} />
                <XAxis
                  type="number"
                  stroke={ct.axis}
                  fontSize={11}
                  tickFormatter={(v) => formatBRLFromCents(Number(v))}
                />
                <YAxis type="category" dataKey="name" width={110} stroke={ct.axis} fontSize={11} tickLine={false} />
                <Tooltip
                  formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                  contentStyle={tooltipStyle(ct)}
                />
                <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                  {bankSpend.map((_, i) => (
                    <Cell key={`${i}-${suffix}`} fill={COLORS[i % COLORS.length]} opacity={0.92} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        />
      )}

      {pieData.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Despesas por categoria</CardTitle>
          </CardHeader>
          <CardContent className="min-h-32">
            <p className="text-sm text-muted">Sem despesas categorizadas neste mês.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ExpandableChartCard
            title="Despesas por categoria"
            subtitle="Donut — clique na fatia para ver o extrato"
            svgIdPrefix="mo-pie"
            size="md"
            renderChart={(suffix) => (
              <ResponsiveContainer width="100%" height="100%" key={suffix}>
                <PieChart margin={{ top: 20, right: 56, bottom: 20, left: 56 }}>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={88}
                    paddingAngle={2}
                    labelLine={{ stroke: ct.axis, strokeWidth: 1 }}
                    label={(props: PieLabelRenderProps) => {
                      const pct = Number(props.percent ?? 0)
                      if (pct < 0.035) return null
                      const cents = Math.round(Number(props.value ?? 0))
                      const raw = String(props.name ?? '')
                      const short = raw.length > 20 ? `${raw.slice(0, 18)}…` : raw
                      const pctLabel = (pct * 100).toFixed(1).replace(/\.0$/, '')
                      const money = formatBRLFromCents(cents)
                      const x = Number(props.x)
                      const y = Number(props.y)
                      const anchor = props.textAnchor ?? 'middle'
                      return (
                        <text fill={ct.tooltipColor} textAnchor={anchor} x={x} y={y}>
                          <tspan x={x} dy="-0.5em" fontSize={11} fontWeight={500}>
                            {short}
                          </tspan>
                          <tspan x={x} dy="1.15em" fontSize={10} fill={ct.tooltipColor} opacity={0.92}>
                            {`${money} · ${pctLabel}%`}
                          </tspan>
                        </text>
                      )
                    }}
                    onClick={(_data, idx) => {
                      const name = pieData[idx]?.name
                      if (name) navigate(`/transactions?category=${encodeURIComponent(name)}`)
                    }}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={`${i}-${suffix}`} fill={COLORS[i % COLORS.length]} stroke="transparent" />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v, _name, item) => {
                      const cents = Number(v ?? 0)
                      const share =
                        pieExpenseTotal > 0 ? ((cents / pieExpenseTotal) * 100).toFixed(1).replace(/\.0$/, '') : '0'
                      return [
                        `${formatBRLFromCents(cents)} (${share}% do total)`,
                        item?.name ?? 'Categoria',
                      ]
                    }}
                    contentStyle={tooltipStyle(ct)}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          />

          <ExpandableChartCard
            title="Despesas por categoria"
            subtitle="Barras — mesmos dados; clique na barra para o extrato"
            svgIdPrefix="mo-cat-bar"
            size="md"
            dialogClassName="max-w-[min(96vw,52rem)]"
            renderChart={(suffix, { tall }) => (
              <ResponsiveContainer width="100%" height="100%" key={suffix}>
                <BarChart
                  layout="vertical"
                  data={pieData}
                  margin={{ left: 4, right: 12, top: 8, bottom: 8 }}
                  barCategoryGap={tall ? 10 : 6}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} horizontal={false} />
                  <XAxis
                    type="number"
                    stroke={ct.axis}
                    fontSize={11}
                    tickLine={false}
                    tickFormatter={(v) => formatBRLFromCents(Number(v))}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={tall ? 120 : 100}
                    stroke={ct.axis}
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => (String(v).length > 16 ? `${String(v).slice(0, 14)}…` : String(v))}
                  />
                  <Tooltip
                    formatter={(v, _name, item) => {
                      const cents = Number(v ?? 0)
                      const share =
                        pieExpenseTotal > 0 ? ((cents / pieExpenseTotal) * 100).toFixed(1).replace(/\.0$/, '') : '0'
                      return [
                        `${formatBRLFromCents(cents)} (${share}% do total)`,
                        item?.name ?? 'Categoria',
                      ]
                    }}
                    contentStyle={tooltipStyle(ct)}
                  />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={28}>
                    {pieData.map((entry, i) => (
                      <Cell
                        key={`${i}-${suffix}`}
                        fill={COLORS[i % COLORS.length]}
                        opacity={0.92}
                        className="cursor-pointer outline-none"
                        onClick={() =>
                          navigate(`/transactions?category=${encodeURIComponent(entry.name)}`)
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          />
        </div>
      )}

      <ExpandableChartCard
        title="Resultado líquido por mês"
        subtitle="Entradas − saídas · últimos 6 meses"
        size="sm"
        svgIdPrefix="mo-net"
        renderChart={(suffix) => (
          <ResponsiveContainer width="100%" height="100%" key={suffix}>
            <BarChart data={monthlyNet} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
              <XAxis dataKey="label" stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} />
              <YAxis
                stroke={ct.axis}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={80}
                tickFormatter={(v) => formatBRLFromCents(Number(v))}
              />
              <Tooltip
                formatter={(v) => formatBRLFromCents(Number(v ?? 0))}
                contentStyle={tooltipStyle(ct)}
              />
              <Bar dataKey="net" name="Líquido" radius={[6, 6, 0, 0]}>
                {monthlyNet.map((e) => (
                  <Cell key={`${e.key}-${suffix}`} fill={e.net >= 0 ? ct.emerald : ct.red} opacity={0.88} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Últimos lançamentos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {txs.slice(0, 8).map((t) => (
            <button
              key={t.id}
              type="button"
              className="flex w-full items-start justify-between gap-2 rounded-xl border border-border/70 bg-surface/40 px-3 py-2.5 text-left text-sm transition hover:border-accent/25"
              onClick={() => navigate('/transactions')}
            >
              <div>
                <p className="line-clamp-2 font-medium">{t.description_raw}</p>
                <p className="text-xs text-muted">
                  {format(new Date(t.date), 'dd MMM', { locale: ptBR })}
                  {t.categories?.name ? ` · ${t.categories.name}` : ''}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 font-mono text-sm tabular-nums',
                  signedAmount(t) >= 0 ? 'text-accent' : 'text-danger',
                )}
              >
                {formatBRLFromCents(signedAmount(t))}
              </span>
            </button>
          ))}
          {txs.length === 0 ? <p className="text-sm text-muted">Nenhum lançamento neste mês.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
