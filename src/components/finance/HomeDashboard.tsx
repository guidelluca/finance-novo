import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAuth } from '@/contexts/AuthContext'
import { useChartTheme } from '@/hooks/useChartTheme'
import { formatBRLFromCents } from '@/lib/currency'
import { consolidateMonth, shiftMonth, type ConsolidatedMonth, type ConsTx } from '@/lib/monthConsolidation'
import { paymentMethodOf, type CardInfo, type MethodGroup } from '@/lib/paymentMethod'
import type { Periods } from '@/lib/period'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

type Props = {
  month: string
  result: ConsolidatedMonth
  monthTxs: ConsTx[]
  history: ConsTx[]
  periods: Periods
  range: { start: string; end: string }
  isCurrent: boolean
  /** posição de hoje no mês financeiro (1 = 1.º dia) */
  refDay: number
  dismissed: Set<string>
  today: string
}

const money = (c: number) => formatBRLFromCents(c)
const short = (c: number) =>
  c >= 100_000 ? `R$ ${(c / 100_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : money(c)

const dayIndex = (iso: string, start: string) =>
  Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000)

/** Cor por forma de pagamento: fixa por entidade, nunca pela posição no ranking. */
const METHOD_SLOT: Partial<Record<MethodGroup, string>> = {
  pix: 'var(--series-1)',
  debito: 'var(--series-3)',
  boleto: 'var(--series-4)',
  transferencia: 'var(--series-6)',
}
const CARD_SLOTS = ['var(--series-2)', 'var(--series-5)']

function Section({ title, subtitle, children, action }: { title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold">{title}</h2>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function HomeDashboard({ month, result, monthTxs, history, periods, range, isCurrent, refDay, dismissed, today }: Props) {
  const { user } = useAuth()
  const ct = useChartTheme()
  const [cards, setCards] = useState<Map<string, CardInfo>>(new Map())
  useEffect(() => {
    if (!user) return
    void supabase
      .from('credit_cards')
      .select('id, name, last4')
      .eq('user_id', user.id)
      .then(({ data }) => setCards(new Map(((data ?? []) as CardInfo[]).map((c) => [c.id, c]))))
  }, [user])

  const owner = (user?.user_metadata?.owner_name as string | undefined) ?? null
  const all = useMemo(() => [...history, ...monthTxs], [history, monthTxs])

  // 6 meses financeiros, cada um consolidado (sem repetidas, estornos, transferências entre contas)
  const monthly = useMemo(() => {
    const months = [5, 4, 3, 2, 1, 0].map((i) => shiftMonth(month, -i))
    return months.map((m) => {
      const r =
        m === month
          ? result
          : consolidateMonth(m, all.filter((t) => periods.periodOf(t.date) === m), all.filter((t) => periods.periodOf(t.date) < m), today, dismissed, owner, periods.periodOf)
      return {
        key: m,
        label: format(parseISO(`${m}-01`), 'MMM', { locale: ptBR }).replace('.', ''),
        entradas: r.totals.incomeCents / 100,
        saidas: r.totals.expenseCents / 100,
        hasData: r.included.length > 0,
        result: r,
      }
    })
  }, [month, result, all, periods, dismissed, owner, today])
  const withData = monthly.filter((m) => m.hasData)
  const prev = monthly[monthly.length - 2]!

  // gasto acumulado: este mês × mês anterior, dia a dia do mês financeiro
  const cumulative = useMemo(() => {
    const len = dayIndex(range.end, range.start) + 1
    const prevStart = periods.rangeOf(prev.key).start
    const cur = Array.from({ length: len }, () => 0)
    const old = Array.from({ length: len }, () => 0)
    for (const t of result.included) {
      if (t.kind !== 'debit') continue
      const i = Math.min(len - 1, Math.max(0, dayIndex(t.date, range.start)))
      cur[i] = (cur[i] ?? 0) + t.amountCents
    }
    for (const t of prev.result.included) {
      const i = dayIndex(t.date, prevStart)
      if (t.kind === 'debit' && i >= 0 && i < len) old[i] = (old[i] ?? 0) + t.amountCents
    }
    let a = 0
    let b = 0
    return cur.map((v, i) => {
      a += v
      b += old[i] ?? 0
      const date = new Date(Date.parse(`${range.start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
      return {
        dia: `${date.slice(8)}/${date.slice(5, 7)}`,
        este: isCurrent && i + 1 > refDay ? null : a / 100,
        anterior: prev.hasData ? b / 100 : null,
      }
    })
  }, [result, prev, range, periods, isCurrent, refDay])

  // por forma de pagamento (só gastos que contam)
  const byMethod = useMemo(() => {
    const m = new Map<string, { label: string; group: MethodGroup; cents: number; n: number }>()
    for (const t of result.included) {
      if (t.kind !== 'debit') continue
      const pm = paymentMethodOf({ description: t.description, account: t.account, cardId: t.cardId }, cards)
      const group = pm.group === 'tarifa' || pm.group === 'investimento' || pm.group === 'salario' ? 'outro' : pm.group
      const key = group === 'credito' ? pm.key : group
      const cur = m.get(key) ?? { label: group === 'credito' ? pm.label.replace(/^Crédito · /, '') : pm.group === group ? pm.label : 'Outros', group, cents: 0, n: 0 }
      cur.cents += t.amountCents
      cur.n += 1
      m.set(key, cur)
    }
    const total = [...m.values()].reduce((s, x) => s + x.cents, 0)
    // cartões em ordem alfabética para a cor de cada um não mudar de um mês para o outro
    const cardKeys = [...m.entries()].filter(([, v]) => v.group === 'credito').map(([k]) => k).sort()
    return {
      total,
      rows: [...m.entries()]
        .map(([k, v]) => ({
          key: k,
          ...v,
          share: total ? v.cents / total : 0,
          color: v.group === 'credito' ? (CARD_SLOTS[cardKeys.indexOf(k)] ?? 'var(--series-muted)') : (METHOD_SLOT[v.group] ?? 'var(--series-muted)'),
        }))
        .sort((a, b) => b.cents - a.cents),
    }
  }, [result, cards])

  // categorias (top 7 + outras) e estabelecimentos
  const cats = useMemo(() => {
    const list = result.byCategory.filter((g) => g.totalCents > 0)
    const top = list.slice(0, 7)
    const rest = list.slice(7).reduce((s, g) => s + g.totalCents, 0)
    const rows = top.map((g) => ({ name: g.name, cents: g.totalCents, share: g.share, avg: g.avg3Cents, id: g.categoryId }))
    if (rest > 0) rows.push({ name: 'Outras', cents: rest, share: rest / Math.max(1, result.totals.expenseCents), avg: null, id: null })
    return rows
  }, [result])
  const maxCat = Math.max(1, ...cats.map((c) => c.cents))

  const merchants = useMemo(() => {
    const m = new Map<string, { name: string; cents: number; n: number }>()
    for (const t of result.included) {
      if (t.kind !== 'debit') continue
      const cur = m.get(t.merchantKey) ?? { name: t.merchant, cents: 0, n: 0 }
      cur.cents += t.amountCents
      cur.n += 1
      m.set(t.merchantKey, cur)
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents).slice(0, 6)
  }, [result])
  const maxMerchant = Math.max(1, ...merchants.map((x) => x.cents))

  // indicadores
  const spent = result.totals.expenseCents
  const days = dayIndex(range.end, range.start) + 1
  const elapsed = isCurrent ? refDay : days
  const perDay = elapsed ? Math.round(spent / elapsed) : 0
  const projection = isCurrent ? Math.round(perDay * days) : null
  const past3 = monthly.slice(2, 5).filter((m) => m.hasData)
  const avg3 = past3.length ? Math.round((past3.reduce((s, m) => s + m.saidas, 0) / past3.length) * 100) : null
  const vsAvg = avg3 ? (projection ?? spent) / avg3 - 1 : null

  if (result.included.length === 0) return null

  const tooltipStyle = {
    background: ct.tooltipBg,
    border: `1px solid ${ct.tooltipBorder}`,
    borderRadius: 12,
    color: ct.tooltipColor,
    fontSize: 12,
  }
  const brlTick = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `${Math.round(v)}`)
  const brlTip = (v: unknown) => (typeof v === 'number' ? money(Math.round(v * 100)) : '—')

  return (
    <div className="space-y-3.5" aria-label="Painel de gastos">
      <h2 className="px-1 pt-2 font-display text-[22px] font-bold">Painel do mês</h2>

      {/* Indicadores */}
      <div className="grid grid-cols-3 gap-2.5">
        {[
          { label: 'Média por dia', value: short(perDay), note: `${elapsed} de ${days} dias` },
          projection != null
            ? { label: 'Projeção do mês', value: short(projection), note: 'no ritmo atual' }
            : { label: 'Gasto no mês', value: short(spent), note: 'mês fechado' },
          {
            label: 'Vs. média 3 meses',
            value: vsAvg == null ? '—' : `${vsAvg > 0 ? '+' : '−'}${Math.abs(Math.round(vsAvg * 100))}%`,
            note: avg3 ? `média ${short(avg3)}` : 'sem histórico',
            tone: vsAvg == null ? '' : vsAvg > 0.05 ? 'text-danger' : vsAvg < -0.05 ? 'text-positive' : '',
          },
        ].map((k) => (
          <div key={k.label} className="space-y-0.5 rounded-[18px] border border-border bg-surface px-3 py-3">
            <p className="text-[11px] leading-tight text-muted">{k.label}</p>
            <p className={cn('truncate font-display text-[17px] font-bold tabular-nums', 'tone' in k ? k.tone : '')}>{k.value}</p>
            <p className="truncate text-[11px] text-muted">{k.note}</p>
          </div>
        ))}
      </div>

      {/* Gasto acumulado */}
      <Section title="Gasto acumulado" subtitle={`Dia a dia do mês financeiro (${range.start.slice(8)}/${range.start.slice(5, 7)}–${range.end.slice(8)}/${range.end.slice(5, 7)}), comparado ao mês anterior`}>
        <div className="h-48" role="img" aria-label={`Gasto acumulado: ${money(spent)} até agora${prev.hasData ? `; no mesmo ponto do mês anterior, ${money(Math.round((cumulative[Math.min(elapsed, cumulative.length) - 1]?.anterior ?? 0) * 100))}` : ''}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cumulative} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={ct.grid} vertical={false} />
              <XAxis dataKey="dia" tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(cumulative.length / 5) - 1)} />
              <YAxis tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={brlTick} width={48} />
              <Tooltip contentStyle={tooltipStyle} formatter={brlTip} labelFormatter={(l) => `Dia ${l}`} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
              {prev.hasData ? (
                <Line name={`Mês anterior (${prev.label})`} type="monotone" dataKey="anterior" stroke="var(--series-muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              ) : null}
              <Line name="Este mês" type="monotone" dataKey="este" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* Categorias */}
      <Section
        title="Para onde foi"
        subtitle={`${money(spent)} em gastos, por categoria`}
        action={
          <Link to="/orcamento" className="text-sm font-semibold underline">
            Orçamento
          </Link>
        }
      >
        <ul className="space-y-2.5">
          {cats.map((c) => (
            <li key={c.name}>
              <Link to={c.id ? `/transactions?month=${month}&category=${encodeURIComponent(c.name)}` : `/transactions?month=${month}`} className="block space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {money(c.cents)} <span className="text-xs text-muted">· {Math.round(c.share * 100)}%</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-background">
                  <div className="h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${Math.max(2, (c.cents / maxCat) * 100)}%` }} />
                </div>
                {c.avg ? (
                  <p className={cn('text-[11px]', c.cents > c.avg * 1.2 ? 'text-danger' : 'text-muted')}>
                    média 3 meses {money(c.avg)}
                    {c.cents > c.avg * 1.2 ? ` · ${Math.round((c.cents / c.avg - 1) * 100)}% acima` : ''}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      {/* Forma de pagamento */}
      <Section title="Como você pagou" subtitle="Gastos por forma de pagamento e cartão">
        <div className="flex h-4 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={byMethod.rows.map((r) => `${r.label} ${Math.round(r.share * 100)}%`).join(', ')}>
          {byMethod.rows.map((r) => (
            <div key={r.key} title={`${r.label}: ${money(r.cents)}`} style={{ width: `${r.share * 100}%`, background: r.color }} className="h-full first:rounded-l-full last:rounded-r-full" />
          ))}
        </div>
        <ul className="divide-y divide-[#eeefe9] dark:divide-[#2b2e34]">
          {byMethod.rows.map((r) => (
            <li key={r.key}>
              <Link
                to={`/transactions?month=${month}&q=${encodeURIComponent(r.group === 'credito' ? r.label : r.label === 'Outros' ? '' : r.label)}`}
                className="flex items-center gap-2.5 py-2.5 text-sm"
              >
                <span className="size-3 shrink-0 rounded-[3px]" style={{ background: r.color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {r.group === 'credito' ? `Crédito · ${r.label}` : r.label}
                  <span className="text-xs text-muted"> · {r.n} lanç.</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(r.cents)}</span>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted">{Math.round(r.share * 100)}%</span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      {/* Entradas × saídas */}
      {withData.length >= 2 ? (
        <Section title="Entradas × saídas" subtitle="Últimos 6 meses financeiros, sem repetidas nem transferências entre suas contas">
          <div className="h-52" role="img" aria-label={monthly.map((m) => `${m.label}: entradas ${money(Math.round(m.entradas * 100))}, saídas ${money(Math.round(m.saidas * 100))}`).join('; ')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly} margin={{ top: 6, right: 8, bottom: 0, left: -8 }} barGap={2} barCategoryGap="28%">
                <CartesianGrid stroke={ct.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: ct.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={brlTick} width={48} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={brlTip}
                  cursor={{ fill: ct.grid, opacity: 0.4 }}
                  labelFormatter={(l, p) => {
                    const row = p?.[0]?.payload as { entradas: number; saidas: number } | undefined
                    return row ? `${l} · saldo ${money(Math.round((row.entradas - row.saidas) * 100))}` : String(l)
                  }}
                />
                <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                <Bar name="Entradas" dataKey="entradas" fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar name="Saídas" dataKey="saidas" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-semibold text-muted">Ver em tabela</summary>
            <table className="mt-2 w-full text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 font-medium">Mês</th>
                  <th className="py-1 text-right font-medium">Entradas</th>
                  <th className="py-1 text-right font-medium">Saídas</th>
                  <th className="py-1 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((m) => (
                  <tr key={m.key} className="border-t border-border">
                    <td className="py-1 capitalize">{m.label}</td>
                    <td className="py-1 text-right">{money(Math.round(m.entradas * 100))}</td>
                    <td className="py-1 text-right">{money(Math.round(m.saidas * 100))}</td>
                    <td className={cn('py-1 text-right', m.entradas - m.saidas < 0 && 'text-danger')}>{money(Math.round((m.entradas - m.saidas) * 100))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Section>
      ) : null}

      {/* Onde mais gastou */}
      <Section title="Onde mais gastou" subtitle="Estabelecimentos com maior gasto no mês">
        <ul className="space-y-2.5">
          {merchants.map((m) => (
            <li key={m.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate">
                  {m.name}
                  <span className="text-xs text-muted"> · {m.n}×</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(m.cents)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-background">
                <div className="h-1.5 rounded-full bg-[var(--series-1)]" style={{ width: `${Math.max(2, (m.cents / maxMerchant) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
