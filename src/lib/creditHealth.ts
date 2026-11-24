import { isCardPaymentCredit } from '@/lib/cardPayment'
import { cardName, installmentOf, isCreditRow, type CreditRow } from '@/lib/creditAnalysis'
import { projectInstallments } from '@/lib/ofInsights'
import { splitCardUsage, type OfCard } from '@/lib/openFinance'

/**
 * Saúde do cartão em relação à renda. Referências usadas (diretrizes de educação financeira, não regra oficial):
 *  - dívidas + faturas: até 30% da renda líquida;
 *  - limite usado (inclui parcelas): até 30% do limite;
 *  - nunca pagar só o mínimo: o rotativo passa de 400% ao ano.
 */
export const SAFE_CREDIT_PCT = 0.3
export const WARN_CREDIT_PCT = 0.4

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const SALARY = /sal[aá]rio|remunera[cç][aã]o|folha de pag|pagto\.? sal|\bplr\b|participa[cç][aã]o nos lucros|13[ºo]? sal|f[eé]rias/i
const CARD_PAY_BANK = /fatura paga|pagamento (de |da )?fatura|pgto\.? ?fatura|pag(to|amento)? (de )?cart[aã]o|pagamento de fatura/i

const ISSUERS: [RegExp, string][] = [
  [/ita[uú]|itaucard/, 'itau'],
  [/nubank|nu ?pagamentos|\bnu\b/, 'nubank'],
  [/picpay/, 'picpay'],
  [/\binter\b|bancointer/, 'inter'],
  [/mercado ?pago/, 'mercadopago'],
  [/\bc6\b/, 'c6'],
]
const issuerOf = (text: string) => ISSUERS.find(([re]) => re.test(fold(text)))?.[1] ?? null

/** Renda do mês: salários e similares que caíram na conta (ou o valor que você definiu). */
export function incomeOf(monthAll: CreditRow[]): number {
  return monthAll.filter((t) => t.kind === 'credit' && !isCreditRow(t) && SALARY.test(t.description_raw)).reduce((s, t) => s + t.amount_cents, 0)
}

export type CardLedger = {
  card: string
  boughtCents: number
  installmentsCents: number
  paidCents: number
  toPayCents: number | null
  futureCents: number
}

/**
 * Uma linha por cartão: comprou no mês (pela data da compra), parcelas do mês, quanto pagou de fatura no mês,
 * quanto falta pagar (pelo banco, se conectado) e quanto já está comprometido em parcelas futuras.
 */
export function cardLedger(input: {
  monthCredit: CreditRow[]
  monthAll: CreditRow[]
  allCredit: CreditRow[]
  today: string
  ofCards: { today: string; cards: (OfCard & { bank: string })[] } | null
}): CardLedger[] {
  const names = [...new Set([...input.allCredit.map(cardName), ...(input.ofCards?.cards ?? []).map((c) => c.bank.replace(/^Banco\s+/i, ''))])]
  const future = projectInstallments(input.allCredit, input.today, 24)
  return names
    .map((card) => {
      const mine = input.monthCredit.filter((t) => cardName(t) === card)
      const bought = mine.reduce((s, t) => s + (t.kind === 'debit' ? t.amount_cents : -t.amount_cents), 0)
      const inst = mine.filter((t) => t.kind === 'debit' && installmentOf(t.description_raw)).reduce((s, t) => s + t.amount_cents, 0)
      // pago: o "pagamento recebido" lançado no próprio cartão; se não tiver, o débito "pagamento de fatura" da conta
      const cardSide = input.monthAll
        .filter((t) => isCreditRow(t) && cardName(t) === card && t.kind === 'credit' && isCardPaymentCredit(t.description_raw))
        .reduce((s, t) => s + t.amount_cents, 0)
      const iss = issuerOf(card)
      const bankSide = input.monthAll
        .filter((t) => !isCreditRow(t) && t.kind === 'debit' && CARD_PAY_BANK.test(t.description_raw) && iss && issuerOf(t.description_raw) === iss)
        .reduce((s, t) => s + t.amount_cents, 0)
      const of = input.ofCards?.cards.find((c) => fold(c.bank).includes(fold(card)) || fold(card).includes(fold(c.bank.replace(/^banco\s+/i, ''))))
      const u = of ? splitCardUsage(of, input.ofCards!.today) : null
      const fut = future.reduce((s, m) => s + m.items.filter((i) => fold(i.account).includes(fold(card))).reduce((a, i) => a + i.cents, 0), 0)
      return {
        card,
        boughtCents: bought,
        installmentsCents: inst,
        paidCents: cardSide || bankSide,
        toPayCents: u ? u.closedUnpaid + u.open : null,
        futureCents: fut,
      }
    })
    .filter((r) => r.boughtCents || r.paidCents || r.toPayCents || r.futureCents)
    .sort((a, b) => b.boughtCents - a.boughtCents)
}

export type CreditHealth = {
  incomeCents: number
  incomeSource: 'manual' | 'extrato' | null
  spentCents: number
  pct: number | null
  safeCents: number | null
  overCents: number
  /** quanto ainda cabe no crédito este mês sem passar de 30% da renda */
  roomCents: number | null
  roomPerDayCents: number | null
  nextMonthInstallmentsCents: number
  nextMonthPct: number | null
  limitUsePct: number | null
  status: 'saudavel' | 'atencao' | 'alto' | 'sem_renda'
}

export function creditHealth(input: {
  spentCents: number
  incomeCents: number
  incomeSource: CreditHealth['incomeSource']
  daysLeft: number
  nextMonthInstallmentsCents: number
  ofCards: { cards: OfCard[] } | null
}): CreditHealth {
  const inc = input.incomeCents
  const limits = (input.ofCards?.cards ?? []).filter((c) => c.limitCents)
  const used = limits.reduce((s, c) => s + Math.max(0, c.usedCents), 0)
  const lim = limits.reduce((s, c) => s + (c.limitCents ?? 0), 0)
  if (!inc)
    return {
      incomeCents: 0,
      incomeSource: null,
      spentCents: input.spentCents,
      pct: null,
      safeCents: null,
      overCents: 0,
      roomCents: null,
      roomPerDayCents: null,
      nextMonthInstallmentsCents: input.nextMonthInstallmentsCents,
      nextMonthPct: null,
      limitUsePct: lim ? used / lim : null,
      status: 'sem_renda',
    }
  const pct = input.spentCents / inc
  const safe = Math.round(inc * SAFE_CREDIT_PCT)
  const room = Math.max(0, safe - input.spentCents)
  return {
    incomeCents: inc,
    incomeSource: input.incomeSource,
    spentCents: input.spentCents,
    pct,
    safeCents: safe,
    overCents: Math.max(0, input.spentCents - safe),
    roomCents: room,
    roomPerDayCents: input.daysLeft > 0 ? Math.floor(room / input.daysLeft) : null,
    nextMonthInstallmentsCents: input.nextMonthInstallmentsCents,
    nextMonthPct: input.nextMonthInstallmentsCents / inc,
    limitUsePct: lim ? used / lim : null,
    status: pct <= SAFE_CREDIT_PCT ? 'saudavel' : pct <= WARN_CREDIT_PCT ? 'atencao' : 'alto',
  }
}
