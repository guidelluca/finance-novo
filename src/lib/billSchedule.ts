import { isCardPaymentCredit } from '@/lib/cardPayment'
import { parseInstallment, scheduleInstallments } from '@/lib/installmentSchedule'

/**
 * Quando e quanto você paga em cada cartão.
 * Cada cartão tem uma regra de vencimento (dia fixo, ex. 15, ou último dia útil do mês) e fecha alguns dias antes.
 * A fatura k soma as compras do ciclo (fechamento anterior, fechamento] + as parcelas que caem nele.
 */
export type DueRule = { kind: 'dia'; day: number; closeDaysBefore: number } | { kind: 'ultimo_util'; closeDaysBefore: number }

export type BillTx = { id: string; date: string; amount_cents: number; kind: 'debit' | 'credit'; description_raw: string; account: string | null }

const CARD = /^cart[aã]o\b|cr[eé]dito/i
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Regras que você contou: Itaú vence no último dia útil; Inter e PicPay no dia 15. */
export function defaultRule(card: string): DueRule | null {
  const c = fold(card)
  if (/itau/.test(c)) return { kind: 'ultimo_util', closeDaysBefore: 7 }
  if (/inter\b|picpay/.test(c)) return { kind: 'dia', day: 15, closeDaysBefore: 7 }
  return null
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const weekday = (s: string) => new Date(`${s}T12:00:00Z`).getUTCDay()
export function addDays(s: string, n: number) {
  const d = new Date(`${s}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Vencimento no mês (ym = "2026-12"). Dia fixo que cai no fim de semana passa para o próximo dia útil. */
export function dueDateIn(rule: DueRule, ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (rule.kind === 'ultimo_util') {
    let d = last
    while ([0, 6].includes(weekday(iso(y, m, d)))) d -= 1
    return iso(y, m, d)
  }
  let out = iso(y, m, Math.min(rule.day, last))
  while ([0, 6].includes(weekday(out))) out = addDays(out, 1)
  return out
}

const nextYm = (ym: string, n = 1) => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export type Bill = {
  card: string
  due: string
  close: string
  from: string
  cents: number
  purchasesCents: number
  installmentsCents: number
  status: 'aberta' | 'fechada' | 'paga' | 'futura'
  items: { date: string; description: string; cents: number; projected: boolean }[]
}

export function billSchedule(rows: BillTx[], rules: Record<string, DueRule>, today: string, count = 4): Bill[] {
  const cardRows = rows.filter((t) => CARD.test(t.account ?? ''))
  const cards = [...new Set(cardRows.map((t) => t.account!))]
  const sched = scheduleInstallments(
    cardRows.map((t) => ({ id: t.id, date: t.date, amountCents: t.amount_cents, kind: t.kind, description: t.description_raw, account: t.account })),
  )
  const out: Bill[] = []
  for (const card of cards) {
    const rule = rules[card] ?? defaultRule(card)
    if (!rule) continue
    const mine = cardRows.filter((t) => t.account === card)
    const payments = mine.filter((t) => t.kind === 'credit' && isCardPaymentCredit(t.description_raw))
    const spend = mine.filter((t) => !(t.kind === 'credit' && isCardPaymentCredit(t.description_raw)))
    const proj = sched.projected.filter((p) => p.source.account === card)
    // primeiro vencimento que ainda não passou (com folga de 3 dias para o pagamento entrar)
    let ym = today.slice(0, 7)
    if (dueDateIn(rule, ym) < addDays(today, -3)) ym = nextYm(ym)
    ym = nextYm(ym, -1) // começa um antes para ter o fechamento anterior
    let prevClose = addDays(dueDateIn(rule, ym), -rule.closeDaysBefore)
    for (let k = 1; k <= count; k++) {
      const due = dueDateIn(rule, nextYm(ym, k))
      const close = addDays(due, -rule.closeDaysBefore)
      const items: Bill['items'] = []
      let purchases = 0
      let inst = 0
      for (const t of spend) {
        const d = sched.effDate.get(t.id) ?? t.date
        if (d <= prevClose || d > close) continue
        const v = t.kind === 'debit' ? t.amount_cents : -t.amount_cents
        if (parseInstallment(t.description_raw)) inst += v
        else purchases += v
        items.push({ date: d, description: t.description_raw, cents: v, projected: false })
      }
      for (const p of proj) {
        if (p.date <= prevClose || p.date > close) continue
        inst += p.source.amountCents
        items.push({ date: p.date, description: `${p.base} (parcela ${p.n}/${p.of})`, cents: p.source.amountCents, projected: true })
      }
      const cents = purchases + inst
      const paid = payments.filter((t) => t.date > close && t.date <= addDays(due, 5)).reduce((s, t) => s + t.amount_cents, 0)
      const status: Bill['status'] =
        cents > 0 && paid >= cents * 0.95 ? 'paga' : today > close ? 'fechada' : today > prevClose ? 'aberta' : 'futura'
      out.push({ card, due, close, from: addDays(prevClose, 1), cents, purchasesCents: purchases, installmentsCents: inst, status, items: items.sort((a, b) => (a.date < b.date ? -1 : 1)) })
      prevClose = close
    }
  }
  return out.filter((b) => b.status !== 'paga' || b.due >= addDays(today, -3)).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.card.localeCompare(b.card)))
}
