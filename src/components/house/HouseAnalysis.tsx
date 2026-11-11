import { Check, Download, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { readHouse, selfResident } from '@/lib/house'
import {
  billSeries,
  collectiveCategory,
  monthsFrom,
  peopleHistory,
  reconcileMonth,
  summarizeMonth,
  type BankTx,
} from '@/lib/houseAnalysis'
import { fetchCaixinha, fetchHouseMonths, readAllSheetCaches, readCaixinhaCache, SHEET_EVENT, type CaixinhaItem } from '@/lib/houseSheet'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const brl = (c: number) => formatBRLFromCents(c)
const brl0 = (c: number) => formatBRLFromCents(c).replace(/,00$/, '')
const short = (c: number) => (Math.abs(c) >= 100_000 ? `R$ ${(c / 100_000).toFixed(1).replace('.', ',')} mil` : brl0(c))
const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const tooltipStyle = { borderRadius: 12, border: '1px solid var(--color-border)', fontSize: 12, background: 'var(--color-surface)' }
const ymShort = (ym: string) => {
  const m = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(ym.slice(5, 7)) - 1]
  return `${m}/${ym.slice(2, 4)}`
}

type Tab = 'mes' | 'moradores' | 'contas' | 'banco' | 'caixinha'

/** Análise completa da casa a partir da planilha (todas as abas mensais) e do seu extrato. */
export function HouseAnalysis() {
  const { user } = useAuth()
  const house = readHouse(user)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const on = () => setVersion((v) => v + 1)
    window.addEventListener(SHEET_EVENT, on)
    return () => window.removeEventListener(SHEET_EVENT, on)
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sheets = useMemo(() => readAllSheetCaches(), [version])
  const months = useMemo(() => monthsFrom(sheets), [sheets])
  const available = useMemo(() => {
    const all = Object.values(sheets).flatMap((s) => s.availableMonths ?? [])
    const seen = new Map(all.map((m) => [m.title, m]))
    return [...seen.values()].sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))
  }, [sheets])
  const missing = available.filter((m) => !sheets[m.title])
  const [tab, setTab] = useState<Tab>('mes')
  const [sel, setSel] = useState<string | null>(null)
  const [loadingAll, setLoadingAll] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const loadAll = async (onlyMissing: boolean) => {
    const tabs = (onlyMissing ? missing : available).map((m) => m.title)
    if (!tabs.length) return
    setErr(null)
    const r = await fetchHouseMonths(tabs, (d, t) => setLoadingAll(`${d}/${t}`))
    setLoadingAll(null)
    if (r.failed.length) setErr(`Não consegui ler: ${r.failed.join(', ')}. Tente de novo.`)
  }

  const current = months.find((m) => m.tab === sel) ?? months[months.length - 1] ?? null
  const summary = useMemo(() => (current ? summarizeMonth(current) : null), [current])
  const hist = useMemo(() => peopleHistory(months), [months])
  const bills = useMemo(() => billSeries(months), [months])

  // extrato no período das abas carregadas (Pix dos moradores e pagamento à imobiliária)
  const [txs, setTxs] = useState<BankTx[]>([])
  const range = months.length ? { from: `${months[0]!.ym}-01`, to: `${months[months.length - 1]!.ym}-28` } : null
  const loadTxs = useCallback(async () => {
    if (!user || !range) return
    const fromD = new Date(`${range.from}T12:00:00Z`)
    fromD.setUTCDate(fromD.getUTCDate() - 35)
    const out: BankTx[] = []
    for (let i = 0; i < 10000; i += 1000) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, date, amount_cents, kind, description_raw')
        .eq('user_id', user.id)
        .gte('date', fromD.toISOString().slice(0, 10))
        .lte('date', range.to)
        .gte('amount_cents', 5000)
        .order('date')
        .range(i, i + 999)
      if (error) return setErr(error.message)
      out.push(...((data ?? []) as BankTx[]))
      if (!data || data.length < 1000) break
    }
    setTxs(out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, range?.from, range?.to])
  useEffect(() => {
    void loadTxs()
  }, [loadTxs])

  const ownerName = (user?.user_metadata?.owner_name as string | undefined) ?? null
  const latest = months[months.length - 1]
  const self = latest ? selfResident(latest.sheet.residents, house, ownerName) : null
  const payeeRe = useMemo(() => new RegExp(house.payees.map((p) => p.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(' ')[0]).join('|') || 'lanza'), [house.payees])
  const recon = useMemo(() => months.map((m) => reconcileMonth(m, txs, self?.nome ?? ownerName, payeeRe)), [months, txs, self, ownerName, payeeRe])

  const [cx, setCx] = useState<{ at: string; items: CaixinhaItem[] } | null>(() => readCaixinhaCache())
  const loadCx = async () => {
    try {
      setCx({ at: new Date().toISOString(), items: await fetchCaixinha() })
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  if (!months.length) return null

  return (
    <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Análise da casa (planilha)</h2>
          <p className="text-xs text-muted">
            {months.length} {months.length === 1 ? 'mês lido' : 'meses lidos'} · {ymShort(months[0]!.ym)} a {ymShort(months[months.length - 1]!.ym)}
          </p>
        </div>
        {available.length > months.length || loadingAll ? (
          <Button size="sm" variant="secondary" disabled={Boolean(loadingAll)} onClick={() => void loadAll(true)}>
            <Download className="size-4" /> {loadingAll ? `Lendo ${loadingAll}…` : `Ler mais ${missing.length} meses`}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={Boolean(loadingAll)} onClick={() => void loadAll(false)}>
            {loadingAll ? `Lendo ${loadingAll}…` : 'Reler tudo'}
          </Button>
        )}
      </div>
      {err ? <p className="text-xs text-danger">{err}</p> : null}

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist">
        {(
          [
            ['mes', 'Mês'],
            ['moradores', 'Moradores'],
            ['contas', 'Contas'],
            ['banco', 'Banco × planilha'],
            ['caixinha', 'Caixinha'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              'shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors',
              tab === k ? 'border-ink bg-ink font-semibold text-[#f2f3ee]' : 'border-border bg-background text-muted hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div key={tab} className="sheet-in space-y-3">
        {tab === 'mes' && summary && current ? (
          <MonthView months={months} sel={current.tab} onSel={setSel} summary={summary} />
        ) : null}
        {tab === 'moradores' ? <PeopleView hist={hist} months={months} /> : null}
        {tab === 'contas' ? <BillsView bills={bills} /> : null}
        {tab === 'banco' ? <BankView recon={recon} selfName={self?.nome ?? null} /> : null}
        {tab === 'caixinha' ? <CaixinhaView cx={cx} onLoad={() => void loadCx()} /> : null}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ Mês */

function MonthView({ months, sel, onSel, summary }: { months: ReturnType<typeof monthsFrom>; sel: string; onSel: (t: string) => void; summary: ReturnType<typeof summarizeMonth> }) {
  const m = months.find((x) => x.tab === sel)!
  const total = summary.slices.reduce((a, s) => a + s.cents, 0) || 1
  const top = summary.slices.slice(0, 6)
  const rest = summary.slices.slice(6).reduce((a, s) => a + s.cents, 0)
  const pie = [...top, ...(rest ? [{ label: 'Outros', cents: rest }] : [])]
  return (
    <>
      <select className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" value={sel} onChange={(e) => onSel(e.target.value)} aria-label="Mês">
        {[...months].reverse().map((x) => (
          <option key={x.tab} value={x.tab}>
            {x.label}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Aluguel', summary.rentCents],
          ['Contas', summary.billsCents],
          ['Coletivos', summary.collectiveCents],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded-2xl bg-background p-2.5">
            <p className="text-[11px] text-muted">{l}</p>
            <p className="text-sm font-semibold tabular-nums">{short(v as number)}</p>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="relative mx-auto h-[190px] w-[190px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pie} dataKey="cents" nameKey="label" innerRadius={56} outerRadius={88} paddingAngle={1.5} stroke="var(--color-surface)" strokeWidth={2} animationDuration={700}>
                {pie.map((p, i) => (
                  <Cell key={p.label} fill={p.label === 'Outros' ? 'var(--series-muted)' : COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, n: unknown) => [typeof v === 'number' ? `${brl(v)} · ${Math.round((v / total) * 100)}%` : '—', String(n)]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[11px] text-muted">Casa</span>
            <span className="text-sm font-semibold">{short(total)}</span>
          </div>
        </div>
        <ul className="space-y-1 text-sm">
          {pie.map((p, i) => (
            <li key={p.label} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.label === 'Outros' ? 'var(--series-muted)' : COLORS[i % COLORS.length] }} />
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              <span className="font-semibold tabular-nums">{Math.round((p.cents / total) * 100)}%</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{brl(p.cents)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-medium">Morador</th>
              <th className="text-right font-medium">Aluguel</th>
              <th className="text-right font-medium">Contas</th>
              <th className="text-right font-medium">Caixinha</th>
              <th className="text-right font-medium">Extras</th>
              <th className="text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {m.sheet.residents.map((r) => {
              const contas = (r.aguaCents ?? 0) + (r.luzCents ?? 0) + (r.netCents ?? 0) + (r.iptuCents ?? 0)
              const extras = (r.extrasCents ?? 0) + (r.multasCents ?? 0) + (r.dividasCents ?? 0)
              return (
                <tr key={r.nome} className="border-t border-[#eeefe9] dark:border-[#2b2e34]">
                  <td className="py-1.5 font-medium">{r.nome}</td>
                  <td className="text-right tabular-nums">{brl0(r.aluguelCents)}</td>
                  <td className="text-right tabular-nums">{contas ? brl0(contas) : '—'}</td>
                  <td className="text-right tabular-nums">{r.caixinhaCents ? brl0(r.caixinhaCents) : '—'}</td>
                  <td className="text-right tabular-nums">{extras ? brl0(extras) : '—'}</td>
                  <td className="text-right font-semibold tabular-nums">{brl(r.totalCents)}</td>
                </tr>
              )
            })}
            <tr className="border-t border-border font-semibold">
              <td className="py-1.5">Total</td>
              <td className="text-right tabular-nums">{brl0(m.sheet.aluguelSumCents)}</td>
              <td colSpan={3} />
              <td className="text-right tabular-nums">{brl(summary.totalDueCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {summary.bills.length ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Contas do mês</p>
          {summary.bills.map((b) => (
            <div key={`${b.label}${b.vencimento}`} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {b.label}
                {b.vencimento ? <span className="text-xs text-muted"> · vence {b.vencimento}</span> : null}
              </span>
              {b.status ? (
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', /pag|ok|quit/i.test(b.status) ? 'bg-[#eef7d8] text-[#3f5a12] dark:bg-[#2a3317] dark:text-[#c8f169]' : 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]')}>
                  {b.status}
                </span>
              ) : null}
              <span className="shrink-0 tabular-nums">{brl(b.cents)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {(m.sheet.coletivos ?? []).length ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Gastos coletivos (divididos entre todos)</p>
          {(m.sheet.coletivos ?? []).map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {c.oQue || c.obs || 'Sem descrição'} <span className="text-xs text-muted">· pagou {c.quem} · {collectiveCategory(`${c.oQue} ${c.obs}`)}</span>
              </span>
              <span className="shrink-0 tabular-nums">{brl(c.quantoCents)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {(m.sheet.acertos ?? []).length ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Acertos individuais</p>
          {(m.sheet.acertos ?? []).map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {a.quem} deve a {a.paraQuem || '—'}
                {a.obs ? <span className="text-xs text-muted"> · {a.obs}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums">{brl(a.deveCents)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ Moradores */

function PeopleView({ hist, months }: { hist: ReturnType<typeof peopleHistory>; months: ReturnType<typeof monthsFrom> }) {
  const [field, setField] = useState<'totalCents' | 'aluguelCents'>('totalCents')
  // pizza: quem pagou gastos coletivos pela casa (todos os meses)
  const collectivePie = hist.people.filter((p) => p.collectivePaidCents > 0).map((p) => ({ label: p.display, cents: p.collectivePaidCents }))
  const cpTotal = collectivePie.reduce((a, p) => a + p.cents, 0) || 1
  return (
    <>
      {hist.changes.length ? (
        <div className="space-y-1 rounded-2xl bg-background p-3 text-xs">
          <p className="font-semibold">Trocas de moradores</p>
          {hist.changes.map((c) => (
            <p key={c.ym}>
              <strong>{ymShort(c.ym)}</strong>
              {c.entered.length ? ` · entrou ${c.entered.join(', ')}` : ''}
              {c.left.length ? ` · saiu ${c.left.join(', ')}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex rounded-xl border border-border bg-background p-0.5 text-xs" role="group">
        <button type="button" className={cn('flex-1 rounded-lg py-1.5', field === 'totalCents' && 'bg-ink font-semibold text-[#f2f3ee]')} onClick={() => setField('totalCents')}>
          Total do mês
        </button>
        <button type="button" className={cn('flex-1 rounded-lg py-1.5', field === 'aluguelCents' && 'bg-ink font-semibold text-[#f2f3ee]')} onClick={() => setField('aluguelCents')}>
          Só aluguel
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="sticky left-0 bg-surface py-1 pr-2 text-left font-medium">Mês</th>
              {hist.people.map((p) => (
                <th key={p.key} className="px-1.5 text-right font-medium">
                  {p.display}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.ym} className="border-t border-[#eeefe9] dark:border-[#2b2e34]">
                <td className="sticky left-0 bg-surface py-1.5 pr-2 font-medium">{ymShort(m.ym)}</td>
                {hist.people.map((p) => {
                  const v = p.months.find((x) => x.ym === m.ym)
                  return (
                    <td key={p.key} className={cn('px-1.5 text-right tabular-nums', !v && 'text-muted')}>
                      {v ? brl0(v[field]) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-1.5">
        {hist.people.map((p) => (
          <li key={p.key} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.display}</span>
              <span className="block text-xs text-muted">
                {ymShort(p.firstYm)} a {ymShort(p.lastYm)} · {p.months.length} {p.months.length === 1 ? 'mês' : 'meses'} · média {brl0(p.avgTotalCents)}/mês
                {p.collectivePaidCents ? ` · pagou ${brl0(p.collectivePaidCents)} em coletivos` : ''}
              </span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{brl0(p.totalPaidCents)}</span>
          </li>
        ))}
      </ul>
      {collectivePie.length ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Quem bancou os gastos coletivos</p>
          {collectivePie
            .sort((a, b) => b.cents - a.cents)
            .map((p, i) => (
              <div key={p.label} className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span>{p.label}</span>
                  <span className="tabular-nums">
                    {brl0(p.cents)} · {Math.round((p.cents / cpTotal) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-background">
                  <div className="h-full rounded-full" style={{ width: `${(p.cents / cpTotal) * 100}%`, background: COLORS[i % COLORS.length] }} />
                </div>
              </div>
            ))}
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ Contas */

function BillsView({ bills }: { bills: ReturnType<typeof billSeries> }) {
  const top = bills.slice(0, 5)
  const yms = [...new Set(top.flatMap((b) => b.points.map((p) => p.ym)))].sort()
  const data = yms.map((ym) => {
    const row: Record<string, number | string> = { ym: ymShort(ym) }
    for (const b of top) {
      const p = b.points.find((x) => x.ym === ym)
      if (p) row[b.label] = p.cents / 100
    }
    return row
  })
  if (!bills.length) return <p className="text-sm text-muted">Nenhuma conta encontrada nas abas lidas.</p>
  return (
    <>
      {yms.length > 1 ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ym" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, n: unknown) => [typeof v === 'number' ? brl(Math.round(v * 100)) : '—', String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {top.map((b, i) => (
                <Line key={b.key} type="monotone" dataKey={b.label} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 2.5 }} connectNulls animationDuration={700} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted">Leia mais meses (botão acima) para ver como cada conta varia.</p>
      )}
      <ul className="space-y-2">
        {bills.map((b) => {
          const up = (b.lastVsAvgPct ?? 0) >= 15
          const down = (b.lastVsAvgPct ?? 0) <= -15
          return (
            <li key={b.key} className="rounded-2xl bg-background p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{b.label}</span>
                <span className="tabular-nums">{brl(b.lastCents)}</span>
              </div>
              <p className="text-xs text-muted">
                média {brl(b.avgCents)} · mín {brl0(b.minCents)} · máx {brl0(b.maxCents)} · {b.points.length} {b.points.length === 1 ? 'mês' : 'meses'}
              </p>
              {b.lastVsAvgPct != null ? (
                <p className={cn('mt-0.5 text-xs font-semibold', up ? 'text-[#9a3412] dark:text-[#ffb38a]' : down ? 'text-[#3f5a12] dark:text-[#c8f169]' : 'text-muted')}>
                  {up ? '▲' : down ? '▼' : '•'} último mês {b.lastVsAvgPct > 0 ? '+' : ''}
                  {b.lastVsAvgPct}% vs. a média anterior{up ? ' — vale conferir' : ''}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/* ------------------------------------------------------------------ Banco × planilha */

function BankView({ recon, selfName }: { recon: ReturnType<typeof reconcileMonth>[]; selfName: string | null }) {
  const rows = [...recon].reverse()
  return (
    <>
      <p className="text-xs text-muted">
        Para cada mês: Pix que cada morador te mandou (do dia 15 do mês anterior ao dia 25) × o TOTAL da linha dele na planilha.
        {selfName ? ` Sua linha (${selfName}) fica de fora.` : ''} Diferença de até R$ 1 conta como “bate”.
      </p>
      {rows.map((r) => {
        const problems = r.rows.filter((x) => x.status !== 'ok').length
        return (
          <details key={r.ym} className="group rounded-2xl bg-background p-3" open={r === rows[0]}>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
              <span className="font-semibold">{ymShort(r.ym)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                recebido {brl0(r.receivedCents)} de {brl0(r.dueCents)}
                {r.rentPaidCents ? ` · pago à imobiliária ${brl0(r.rentPaidCents)}` : ''}
              </span>
              {problems ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#9a3412] dark:text-[#ffb38a]">
                  <TriangleAlert className="size-3.5" /> {problems}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#3f5a12] dark:text-[#c8f169]">
                  <Check className="size-3.5" /> bate
                </span>
              )}
            </summary>
            <ul className="mt-2 space-y-1.5">
              {r.rows.map((x) => (
                <li key={x.nome} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{x.nome}</span>
                    <span className="text-xs tabular-nums text-muted">
                      {brl0(x.paidCents)} / {brl0(x.dueCents)}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        x.status === 'ok' && 'bg-[#eef7d8] text-[#3f5a12] dark:bg-[#2a3317] dark:text-[#c8f169]',
                        x.status !== 'ok' && 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]',
                      )}
                    >
                      {x.status === 'ok' ? 'bate' : x.status === 'sem_pix' ? 'sem Pix' : x.status === 'falta' ? `falta ${brl0(x.dueCents - x.paidCents)}` : `${brl0(x.paidCents - x.dueCents)} a mais`}
                    </span>
                  </div>
                  {x.txs.length ? (
                    <p className="text-[11px] text-muted">{x.txs.map((t) => `${t.date.slice(8)}/${t.date.slice(5, 7)} ${brl0(t.amount_cents)}`).join(' · ')}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        )
      })}
      <p className="text-[11px] text-muted">“Sem Pix” pode ser extrato ainda não importado ou pagamento por outro meio (dinheiro, conta de outra pessoa).</p>
    </>
  )
}

/* ------------------------------------------------------------------ Caixinha */

function CaixinhaView({ cx, onLoad }: { cx: { at: string; items: CaixinhaItem[] } | null; onLoad: () => void }) {
  const items = cx?.items ?? []
  const saldo = items.reduce((a, i) => a + i.valorCents, 0)
  const entradas = items.filter((i) => i.valorCents > 0).reduce((a, i) => a + i.valorCents, 0)
  const saidas = -items.filter((i) => i.valorCents < 0).reduce((a, i) => a + i.valorCents, 0)
  const byCat = new Map<string, number>()
  for (const i of items.filter((x) => x.valorCents < 0)) {
    const c = collectiveCategory(`${i.descricao} ${i.obs}`)
    byCat.set(c, (byCat.get(c) ?? 0) - i.valorCents)
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{cx ? `Lida em ${new Date(cx.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Ainda não lida'}</p>
        <Button size="sm" variant="secondary" onClick={onLoad}>
          {cx ? 'Atualizar' : 'Ler caixinha'}
        </Button>
      </div>
      {items.length ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ['Saldo', saldo],
              ['Entrou', entradas],
              ['Saiu', saidas],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-2xl bg-background p-2.5">
                <p className="text-[11px] text-muted">{l}</p>
                <p className="text-sm font-semibold tabular-nums">{brl0(v as number)}</p>
              </div>
            ))}
          </div>
          {byCat.size ? (
            <div className="space-y-1 text-xs">
              <p className="text-sm font-semibold">Saídas da caixinha por categoria</p>
              {[...byCat.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([c, v]) => (
                  <div key={c} className="flex justify-between">
                    <span>{c}</span>
                    <span className="tabular-nums">
                      {brl0(v)} · {Math.round((v / Math.max(1, saidas)) * 100)}%
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {items.map((i, k) => (
              <li key={k} className="flex items-center gap-2 border-t border-[#eeefe9] pt-1 first:border-0 dark:border-[#2b2e34]">
                <span className="min-w-0 flex-1 truncate">
                  {i.descricao}
                  <span className="text-xs text-muted"> · {i.data}</span>
                </span>
                <span className={cn('shrink-0 tabular-nums', i.valorCents > 0 && 'text-positive')}>{brl(i.valorCents)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
}
