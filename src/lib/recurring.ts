/**
 * Contas recorrentes a partir do histórico (sem dependências de UI):
 * próximas contas do mês e assinaturas detectadas.
 */
import { identifyMerchant } from './merchantIdentify'
import { shiftMonth, similarMerchant, type ConsItem, type ConsTx } from './monthConsolidation'

export type Recurring = {
  key: string
  name: string
  kind: string | null
  amountCents: number
  /** dia do mês em que costuma cair */
  day: number
  isSubscription: boolean
  /** já apareceu no mês atual? */
  paidThisMonth: boolean
  categoryId: string | null
}

const SUBSCRIPTION = /assinatura|streaming|celular|internet|academia/i

function keyOf(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function asItem(t: ConsTx): ConsItem {
  const m = identifyMerchant(t.description)
  const name = t.merchantName?.trim() || m.name
  return { ...t, merchant: name, merchantKey: keyOf(name), merchantKind: m.kind }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i]! : Math.round((s[i - 1]! + s[i]!) / 2)
}

/** Gastos que se repetem em pelo menos 2 dos 3 meses anteriores com valor parecido (±15%). */
export function detectRecurring(month: string, monthTxs: ConsTx[], history: ConsTx[]): Recurring[] {
  const last3 = [1, 2, 3].map((k) => shiftMonth(month, -k))
  const hist = history.filter((t) => t.kind === 'debit' && last3.includes(t.date.slice(0, 7))).map(asItem)
  const cur = monthTxs.filter((t) => t.kind === 'debit').map(asItem)
  const groups: ConsItem[][] = []
  for (const t of hist) {
    if (/pagamento.*fatura|aplica[cç][aã]o|resgate/i.test(t.description)) continue
    const g = groups.find((gr) => similarMerchant(gr[0]!, t))
    if (g) g.push(t)
    else groups.push([t])
  }
  const out: Recurring[] = []
  for (const g of groups) {
    const months = new Set(g.map((t) => t.date.slice(0, 7)))
    if (months.size < 2) continue
    // uma ocorrência por mês (senão é gasto frequente, não conta fixa)
    if (g.length > months.size + 1) continue
    const amounts = g.map((t) => t.amountCents)
    const med = median(amounts)
    if (amounts.some((a) => Math.abs(a - med) > med * 0.15)) continue
    const ref = [...g].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!
    const paid = cur.some((t) => similarMerchant(ref, t) && Math.abs(t.amountCents - med) <= med * 0.25)
    out.push({
      key: ref.merchantKey,
      name: ref.merchant,
      kind: ref.merchantKind,
      amountCents: ref.amountCents,
      day: median(g.map((t) => Number(t.date.slice(8)))),
      isSubscription: SUBSCRIPTION.test(ref.merchantKind ?? '') || /assinatura/i.test(ref.categoryName ?? ''),
      paidThisMonth: paid,
      categoryId: ref.categoryId,
    })
  }
  return out.sort((a, b) => a.day - b.day)
}
