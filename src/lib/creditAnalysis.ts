import { identifyMerchant } from '@/lib/merchantIdentify'

/** Lançamento salvo com o que a análise de crédito precisa. */
export type CreditRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'debit' | 'credit'
  description_raw: string
  account: string | null
  credit_card_id: string | null
  category_id: string | null
}
export type Cat = { id: string; name: string; parent_id: string | null }

const CARD_ACCOUNT = /^cart[aã]o\b/i
const PAYMENT = /pagamento|pgto|pagto|fatura paga|pag\.? fatura/i
export const PARC = /(?:parcela\s*(\d{1,2})\s*\/\s*(\d{1,2}))|(?:parc\s*(\d{1,2})\s*\/\s*(\d{1,2}))/i

export const isCreditRow = (t: CreditRow) => Boolean(t.credit_card_id) || CARD_ACCOUNT.test(t.account ?? '')
export const cardName = (t: CreditRow) => (t.account ?? 'Cartão').replace(/^cart[aã]o\s+/i, '').trim() || 'Cartão'

/** Compras (débitos) e estornos do cartão; pagamento da fatura não é gasto e sai. */
export function creditMovements(rows: CreditRow[]): CreditRow[] {
  return rows.filter((t) => isCreditRow(t) && !(t.kind === 'credit' && PAYMENT.test(t.description_raw)))
}
const signed = (t: CreditRow) => (t.kind === 'debit' ? t.amount_cents : -t.amount_cents)

export function installmentOf(desc: string): { n: number; of: number } | null {
  const m = desc.match(PARC)
  if (!m) return null
  const n = Number(m[1] ?? m[3])
  const of = Number(m[2] ?? m[4])
  return n && of > 1 && n <= of ? { n, of } : null
}

export type CategorySlice = {
  id: string
  name: string
  cents: number
  children: { name: string; cents: number }[]
  merchants: { name: string; cents: number; count: number }[]
}

export type CreditMonth = {
  totalCents: number
  purchases: number
  refundsCents: number
  avgTicketCents: number
  byCard: { card: string; cents: number; count: number }[]
  byCategory: CategorySlice[]
  topMerchants: { name: string; cents: number; count: number }[]
  biggest: CreditRow[]
  cashCents: number
  installmentsCents: number
  newInstallments: { count: number; commitmentCents: number; items: { name: string; cents: number; of: number }[] }
}

export function analyzeMonth(rows: CreditRow[], cats: Cat[]): CreditMonth {
  const catById = new Map(cats.map((c) => [c.id, c]))
  const topOf = (id: string | null) => {
    let c = id ? catById.get(id) : undefined
    const leaf = c
    while (c?.parent_id && catById.get(c.parent_id)) c = catById.get(c.parent_id)
    return { top: c ?? null, leaf: leaf ?? null }
  }
  const debits = rows.filter((t) => t.kind === 'debit')
  const total = rows.reduce((s, t) => s + signed(t), 0)
  const refunds = rows.filter((t) => t.kind === 'credit').reduce((s, t) => s + t.amount_cents, 0)

  const byCard = new Map<string, { cents: number; count: number }>()
  for (const t of rows) {
    const c = byCard.get(cardName(t)) ?? { cents: 0, count: 0 }
    c.cents += signed(t)
    if (t.kind === 'debit') c.count += 1
    byCard.set(cardName(t), c)
  }

  const cat = new Map<string, { id: string; name: string; cents: number; children: Map<string, number>; merchants: Map<string, { cents: number; count: number }> }>()
  const merchants = new Map<string, { cents: number; count: number }>()
  for (const t of rows) {
    const { top, leaf } = topOf(t.category_id)
    const key = top?.id ?? '__none__'
    const g = cat.get(key) ?? { id: key, name: top?.name ?? 'Sem categoria', cents: 0, children: new Map(), merchants: new Map() }
    g.cents += signed(t)
    const child = leaf && top && leaf.id !== top.id ? leaf.name : null
    if (child) g.children.set(child, (g.children.get(child) ?? 0) + signed(t))
    const mName = identifyMerchant(t.description_raw.replace(PARC, '').replace(/\(\s*\)/g, ' ')).name
    const gm = g.merchants.get(mName) ?? { cents: 0, count: 0 }
    gm.cents += signed(t)
    gm.count += t.kind === 'debit' ? 1 : 0
    g.merchants.set(mName, gm)
    cat.set(key, g)
    const m = merchants.get(mName) ?? { cents: 0, count: 0 }
    m.cents += signed(t)
    m.count += t.kind === 'debit' ? 1 : 0
    merchants.set(mName, m)
  }

  let cash = 0
  let inst = 0
  const fresh: CreditMonth['newInstallments']['items'] = []
  for (const t of debits) {
    const i = installmentOf(t.description_raw)
    if (!i) {
      cash += t.amount_cents
      continue
    }
    inst += t.amount_cents
    if (i.n === 1) fresh.push({ name: identifyMerchant(t.description_raw.replace(PARC, '').replace(/\(\s*\)/g, ' ')).name, cents: t.amount_cents, of: i.of })
  }

  const sortDesc = <T extends { cents: number }>(a: T[]) => a.sort((x, y) => y.cents - x.cents)
  return {
    totalCents: total,
    purchases: debits.length,
    refundsCents: refunds,
    avgTicketCents: debits.length ? Math.round(debits.reduce((s, t) => s + t.amount_cents, 0) / debits.length) : 0,
    byCard: sortDesc([...byCard].map(([card, v]) => ({ card, ...v }))),
    byCategory: sortDesc(
      [...cat.values()].map((g) => ({
        id: g.id,
        name: g.name,
        cents: g.cents,
        children: sortDesc([...g.children].map(([name, cents]) => ({ name, cents }))),
        merchants: sortDesc([...g.merchants].map(([name, v]) => ({ name, ...v }))).slice(0, 8),
      })),
    ).filter((g) => g.cents > 0),
    topMerchants: sortDesc([...merchants].map(([name, v]) => ({ name, ...v }))).slice(0, 8),
    biggest: [...debits].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 5),
    cashCents: cash,
    installmentsCents: inst,
    newInstallments: { count: fresh.length, commitmentCents: fresh.reduce((s, x) => s + x.cents * x.of, 0), items: fresh.sort((a, b) => b.cents * b.of - a.cents * a.of) },
  }
}

/** Gasto acumulado dia a dia dentro de um período (índice 0 = 1.º dia). */
export function cumulative(rows: CreditRow[], start: string, days: number): number[] {
  const out = Array.from({ length: days }, () => 0)
  const base = Date.parse(`${start}T12:00:00Z`)
  for (const t of rows) {
    const i = Math.round((Date.parse(`${t.date}T12:00:00Z`) - base) / 86_400_000)
    if (i >= 0 && i < days) out[i] = (out[i] ?? 0) + signed(t)
  }
  for (let i = 1; i < days; i++) out[i] = (out[i] ?? 0) + (out[i - 1] ?? 0)
  return out
}

export function sumSigned(rows: CreditRow[]): number {
  return rows.reduce((s, t) => s + signed(t), 0)
}
