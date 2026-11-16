import { identifyMerchant } from '@/lib/merchantIdentify'
import { splitCardUsage, type BalanceSnapshot, type OfCard, type OfOverview } from '@/lib/openFinance'

/** Linha mínima de lançamento salvo que as análises usam. */
export type RowTx = { id: string; date: string; amount_cents: number; kind: 'debit' | 'credit'; description_raw: string; account: string | null }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const ymOf = (iso: string) => iso.slice(0, 7)
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)

/* ------------------------------------------------------------------ conferência de saldo */

export type BalanceCheck = {
  label: string
  from: string
  to: string
  bankDeltaCents: number
  appDeltaCents: number
  diffCents: number
  /** trechos entre duas fotos em que a conta não fecha (para achar o dia) */
  gaps: { from: string; to: string; diffCents: number }[]
  lastBalanceCents: number
}

/**
 * Saldo do banco na foto mais antiga + entradas − saídas salvas no app = saldo do banco hoje?
 * Se não bater, faltam (ou sobram) lançamentos naquela conta no período.
 */
export function checkBalances(snaps: BalanceSnapshot[], txs: RowTx[]): BalanceCheck[] {
  if (snaps.length < 2) return []
  const last = snaps[snaps.length - 1]!
  const out: BalanceCheck[] = []
  for (const label of Object.keys(last.balances)) {
    const series = snaps.filter((s) => label in s.balances)
    if (series.length < 2) continue
    const mine = txs.filter((t) => (t.account ?? '') === label)
    const flow = (a: string, b: string) =>
      mine.filter((t) => t.date > a && t.date <= b).reduce((s, t) => s + (t.kind === 'credit' ? t.amount_cents : -t.amount_cents), 0)
    const gaps: BalanceCheck['gaps'] = []
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1]!
      const b = series[i]!
      const d = b.balances[label]! - a.balances[label]! - flow(a.at.slice(0, 10), b.at.slice(0, 10))
      if (Math.abs(d) > 100) gaps.push({ from: a.at.slice(0, 10), to: b.at.slice(0, 10), diffCents: d })
    }
    const first = series[0]!
    const bankDelta = last.balances[label]! - first.balances[label]!
    const appDelta = flow(first.at.slice(0, 10), last.at.slice(0, 10))
    out.push({
      label,
      from: first.at.slice(0, 10),
      to: last.at.slice(0, 10),
      bankDeltaCents: bankDelta,
      appDeltaCents: appDelta,
      diffCents: bankDelta - appDelta,
      gaps,
      lastBalanceCents: last.balances[label]!,
    })
  }
  return out
}

/* ------------------------------------------------------------------ assinaturas */

export type Subscription = {
  key: string
  name: string
  kind: string | null
  monthlyCents: number
  prevMonthlyCents: number | null
  increasePct: number | null
  months: number
  lastDate: string
  charges: number
}

const SUB_KIND = /assinatura|streaming|celular|internet|academia|apoio a criador/i
const INSTALLMENT = /parcela\s*\d+\s*\/\s*\d+|parc\s*\d{1,2}\s*\/\s*\d{1,2}/i
const NOT_SUB = /pix|transfer|ted\b|fatura|sal[aá]rio|aplica|resgate|rdb|cofrinho|uber|99|ifood|mercado|supermerc|aluguel|lanza/i

export function detectSubscriptions(txs: RowTx[], today: string): Subscription[] {
  const since = addMonths(ymOf(today), -5)
  const groups = new Map<string, { name: string; kind: string | null; byMonth: Map<string, number[]>; lastDate: string }>()
  for (const t of txs) {
    if (t.kind !== 'debit' || ymOf(t.date) < since || INSTALLMENT.test(t.description_raw)) continue
    const m = identifyMerchant(t.description_raw)
    const known = SUB_KIND.test(m.kind ?? '')
    if (!known && NOT_SUB.test(t.description_raw)) continue
    const key = fold(m.name).replace(/[^a-z0-9]+/g, ' ').trim()
    if (!key) continue
    const g = groups.get(key) ?? { name: m.name, kind: m.kind, byMonth: new Map(), lastDate: t.date }
    const arr = g.byMonth.get(ymOf(t.date)) ?? []
    arr.push(t.amount_cents)
    g.byMonth.set(ymOf(t.date), arr)
    if (t.date > g.lastDate) g.lastDate = t.date
    groups.set(key, g)
  }
  const out: Subscription[] = []
  for (const [key, g] of groups) {
    const months = [...g.byMonth.keys()].sort()
    const known = SUB_KIND.test(g.kind ?? '')
    if (months.length < (known ? 2 : 3)) continue
    // valores parecidos todo mês (até 30% de variação) — senão é só um lugar que você frequenta
    const totals = months.map((ym) => g.byMonth.get(ym)!.reduce((s, v) => s + v, 0))
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length
    if (!known && totals.some((v) => Math.abs(v - avg) > avg * 0.3)) continue
    // ainda ativa: cobrou nos últimos ~45 dias
    if (dayDiff(g.lastDate, today) > 45) continue
    const lastYm = months[months.length - 1]!
    const prevYm = months[months.length - 2]!
    const lastCharges = g.byMonth.get(lastYm)!
    const prevCharges = g.byMonth.get(prevYm)!
    const monthly = lastCharges.reduce((s, v) => s + v, 0)
    const prev = prevCharges.reduce((s, v) => s + v, 0)
    const sameCount = lastCharges.length === prevCharges.length
    const inc = sameCount && prev > 0 ? monthly / prev - 1 : null
    out.push({
      key,
      name: g.name,
      kind: g.kind,
      monthlyCents: monthly,
      prevMonthlyCents: prev,
      increasePct: inc != null && inc >= 0.05 ? inc : null,
      months: months.length,
      lastDate: g.lastDate,
      charges: lastCharges.length,
    })
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents)
}

/* ------------------------------------------------------------------ parcelas futuras */

export type FutureMonth = { ym: string; cents: number; items: { name: string; account: string; n: number; of: number; cents: number }[] }

const PARC = /(?:parcela\s*(\d{1,2})\s*\/\s*(\d{1,2}))|(?:parc\s*(\d{1,2})\s*\/\s*(\d{1,2}))/i

/**
 * Parcelas que ainda vão cair, a partir das compras parceladas já salvas (cartões).
 * Se todas as parcelas de uma compra vêm com a mesma data (data da compra), a parcela j cai no mês da compra + (j−1);
 * se cada parcela vem na data em que foi cobrada, a próxima cai um mês depois da última.
 */
export function projectInstallments(txs: RowTx[], today: string, ahead = 12): FutureMonth[] {
  const cur = ymOf(today)
  const byKey = new Map<string, { name: string; account: string; cents: number; of: number; seen: { n: number; date: string }[] }>()
  for (const t of txs) {
    if (t.kind !== 'debit') continue
    const m = t.description_raw.match(PARC)
    if (!m) continue
    const n = Number(m[1] ?? m[3])
    const of = Number(m[2] ?? m[4])
    if (!n || !of || of < 2 || n > of || of > 48) continue
    const base = fold(t.description_raw.replace(PARC, '').replace(/[()·]/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim()
    const account = t.account ?? 'Cartão'
    const key = `${fold(account)}|${base}|${of}|${Math.round(t.amount_cents / 100)}`
    const g = byKey.get(key) ?? { name: identifyMerchant(t.description_raw.replace(PARC, '').replace(/\(\s*\)/g, ' ').trim()).name, account, cents: t.amount_cents, of, seen: [] }
    if (!g.seen.some((s) => s.n === n)) g.seen.push({ n, date: t.date })
    byKey.set(key, g)
  }
  const months = new Map<string, FutureMonth>()
  for (const g of byKey.values()) {
    const top = g.seen.reduce((a, b) => (b.n > a.n ? b : a))
    const purchaseDated = g.seen.length > 1 && new Set(g.seen.map((s) => s.date)).size === 1
    for (let j = top.n + 1; j <= g.of; j++) {
      const ym = purchaseDated ? addMonths(ymOf(top.date), j - 1) : addMonths(ymOf(top.date), j - top.n)
      if (ym < cur || ym > addMonths(cur, ahead)) continue
      const fm = months.get(ym) ?? { ym, cents: 0, items: [] }
      fm.cents += g.cents
      fm.items.push({ name: g.name, account: g.account, n: j, of: g.of, cents: g.cents })
      months.set(ym, fm)
    }
  }
  return [...months.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1))
}

/* ------------------------------------------------------------------ dívidas pelo extrato */

export type DebtFromTx = { name: string; account: string; avgMonthlyCents: number; lastDate: string; lastCents: number; months: number }
const DEBT = /renegocia|empr[eé]stimo|d[eé]bito por d[ií]vida|parcela paga|financiamento|consignado|credi[aá]rio|acordo/i

export function debtsFromTxs(txs: RowTx[], today: string): DebtFromTx[] {
  const since = addMonths(ymOf(today), -5)
  const g = new Map<string, { name: string; account: string; byMonth: Map<string, number>; last: RowTx }>()
  for (const t of txs) {
    if (t.kind !== 'debit' || ymOf(t.date) < since || !DEBT.test(t.description_raw)) continue
    const name = t.description_raw.replace(/\s*·.*$/, '').replace(/\s*\|\s*/g, ' · ').trim() || identifyMerchant(t.description_raw).name
    const key = `${t.account ?? ''}|${fold(name)}`
    const x = g.get(key) ?? { name, account: t.account ?? '', byMonth: new Map(), last: t }
    x.byMonth.set(ymOf(t.date), (x.byMonth.get(ymOf(t.date)) ?? 0) + t.amount_cents)
    if (t.date >= x.last.date) x.last = t
    g.set(key, x)
  }
  return [...g.values()]
    .map((x) => {
      const vals = [...x.byMonth.values()]
      return {
        name: x.name,
        account: x.account,
        avgMonthlyCents: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
        lastDate: x.last.date,
        lastCents: x.last.amount_cents,
        months: vals.length,
      }
    })
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1))
}

/* ------------------------------------------------------------------ patrimônio */

export function netWorth(o: OfOverview | null, cards: (OfCard & { bank: string })[] | null) {
  const accounts = (o?.accounts ?? []).filter((a) => a.type !== 'CREDIT')
  const cash = accounts.reduce((s, a) => s + a.balanceCents, 0)
  const invested = (o?.investments ?? []).reduce((s, v) => s + v.balanceCents, 0)
  const cardDebt = (cards ?? []).reduce((s, c) => s + Math.max(0, c.usedCents), 0)
  const loanDebt = (o?.loans ?? []).reduce((s, l) => s + Math.max(0, l.outstandingCents ?? 0), 0)
  return { cash, invested, cardDebt, loanDebt, total: cash + invested - cardDebt - loanDebt }
}

/* ------------------------------------------------------------------ alertas */

export type Alert = { id: string; level: 'alta' | 'media' | 'info'; title: string; detail: string; to?: string }

const BR = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Penúltimo dia útil do mês (dia em que cai o salário do fim do mês). */
export function penultimateBusinessDay(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
  const biz: string[] = []
  for (let d = last; d >= 1 && biz.length < 2; d--) {
    const wd = new Date(Date.UTC(y!, m! - 1, d)).getUTCDay()
    if (wd !== 0 && wd !== 6) biz.push(`${ym}-${String(d).padStart(2, '0')}`)
  }
  return biz[1] ?? `${ym}-${String(last).padStart(2, '0')}`
}

const SALARY = /sal[aá]rio|remunera[cç][aã]o|folha de pag|pagto\.? sal/i
const OVERDRAFT_FEE = /juros\s+(do\s+)?limite|juros\s+cheque|cheque especial|limite da conta|\biof\b.*limite|encargos?\s+limite/i

export function buildAlerts(input: {
  today: string
  cards: { today: string; cards: (OfCard & { bank: string })[] } | null
  overview: OfOverview | null
  txs: RowTx[]
  pace?: { deltaPct: number; spentCents: number; prevCents: number } | null
  rentMissing?: string[]
  balanceChecks?: BalanceCheck[]
}): Alert[] {
  const { today } = input
  const out: Alert[] = []

  for (const c of input.cards?.cards ?? []) {
    const u = splitCardUsage(c, input.cards!.today)
    if (c.dueDate) {
      const d = dayDiff(today, c.dueDate)
      const toPay = u.closedUnpaid || (u.lastBill && u.lastBill.dueDate === c.dueDate ? u.lastBill.totalCents - u.lastBill.paidCents : 0)
      if (d >= 0 && d <= 3 && toPay > 0)
        out.push({ id: `due:${c.accountId}`, level: 'alta', title: `Fatura ${c.bank} vence ${d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`}`, detail: `${BR(toPay)} · vencimento ${ddmm(c.dueDate)}`, to: '/cards' })
    }
    const limit = c.limitCents ?? (c.availableCents != null ? c.availableCents + u.used : null)
    if (limit && u.used / limit >= 0.8)
      out.push({ id: `lim:${c.accountId}`, level: 'media', title: `Cartão ${c.bank} com ${Math.round((u.used / limit) * 100)}% do limite usado`, detail: `${BR(u.used)} de ${BR(limit)} (inclui parcelas futuras)`, to: '/cards' })
  }

  for (const a of input.overview?.accounts ?? []) {
    if (a.type === 'CREDIT') continue
    if (a.balanceCents < 0)
      out.push({ id: `neg:${a.id}`, level: 'alta', title: `${a.bank} está no negativo`, detail: `Saldo ${BR(a.balanceCents)}: o banco cobra juros e IOF do limite por dia. Cubra com outra conta.`, to: '/panorama' })
    else if (a.balanceCents < 10_000 && /ita[uú]/i.test(a.bank))
      out.push({ id: `low:${a.id}`, level: 'media', title: `${a.bank} com saldo baixo`, detail: `Saldo ${BR(a.balanceCents)}: um débito pode entrar no limite (cheque especial).`, to: '/panorama' })
  }

  const recentFees = input.txs.filter((t) => t.kind === 'debit' && dayDiff(t.date, today) <= 35 && OVERDRAFT_FEE.test(t.description_raw))
  if (recentFees.length) {
    const sum = recentFees.reduce((s, t) => s + t.amount_cents, 0)
    out.push({ id: 'fees', level: 'media', title: 'Você pagou juros do cheque especial', detail: `${BR(sum)} nos últimos 35 dias (${recentFees.map((t) => `${t.account ?? ''} ${ddmm(t.date)}`).join(', ')}). Deixe um colchão na conta antes dos débitos.`, to: '/panorama' })
  }

  // salário (dia 15 e penúltimo dia útil)
  const ym = ymOf(today)
  const salaries = input.txs.filter((t) => t.kind === 'credit' && SALARY.test(t.description_raw))
  if (salaries.length) {
    const day = Number(today.slice(8, 10))
    const has = (from: string, to: string) => salaries.some((t) => t.date >= from && t.date <= to)
    if (day >= 17 && !has(`${ym}-12`, `${ym}-17`))
      out.push({ id: `sal15:${ym}`, level: 'media', title: 'Salário do dia 15 não apareceu', detail: 'Nenhum crédito de salário entre 12 e 17 deste mês. Pode ser só falta de sincronizar ou importar o extrato.', to: '/import' })
    const pbd = penultimateBusinessDay(ym)
    if (dayDiff(pbd, today) >= 2 && !has(addDaysIso(pbd, -3), `${ym}-31`))
      out.push({ id: `salfim:${ym}`, level: 'media', title: 'Salário do fim do mês não apareceu', detail: `Esperado por volta de ${ddmm(pbd)}.`, to: '/import' })
  }

  if (input.pace && input.pace.deltaPct >= 0.15 && input.pace.spentCents - input.pace.prevCents >= 20_000)
    out.push({ id: 'pace', level: 'media', title: `Gastando ${Math.round(input.pace.deltaPct * 100)}% mais que no mês passado`, detail: `${BR(input.pace.spentCents)} até agora, contra ${BR(input.pace.prevCents)} no mesmo ponto do mês anterior.` })

  if (input.rentMissing?.length)
    out.push({ id: `rent:${ym}`, level: 'media', title: 'Aluguel: falta Pix de moradores', detail: input.rentMissing.join(', '), to: '/casa' })

  for (const b of input.balanceChecks ?? [])
    if (Math.abs(b.diffCents) > 100)
      out.push({
        id: `bal:${b.label}`,
        level: 'media',
        title: `${b.label}: saldo do banco não bate com o app`,
        detail: `De ${ddmm(b.from)} a ${ddmm(b.to)} o banco mudou ${BR(b.bankDeltaCents)} e os lançamentos somam ${BR(b.appDeltaCents)} (${b.diffCents > 0 ? 'faltam entradas' : 'faltam saídas'} de ${BR(Math.abs(b.diffCents))}).`,
        to: '/panorama',
      })

  const rank = { alta: 0, media: 1, info: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

function addDaysIso(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
