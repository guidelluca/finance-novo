import { format, isAfter, isBefore, isSameDay, parseISO } from 'date-fns'
import type { CreditCard, Transaction } from '@/types/database'

/**
 * Retorna o último dia realmente válido dentro do mês (para closing/due 29,30,31).
 */
function clampDayToMonth(year: number, month: number, day: number): Date {
  const d = new Date(year, month - 1, day)
  if (d.getMonth() !== month - 1) {
    // clamp: dia excede o mês (ex.: 31/02) → último dia do mês
    return new Date(year, month, 0)
  }
  return d
}

/**
 * Uma fatura de cartão. `label` = mês/ano do vencimento ("outubro/2025"),
 * que é a convenção comum no Brasil. O ciclo cobre transações com date
 * entre closingDate anterior (exclusivo) e closingDate atual (inclusivo).
 */
export interface CardBillCycle {
  card: CreditCard
  /** Data (ISO YYYY-MM-DD) do início do ciclo (dia seguinte ao fechamento anterior). */
  startIso: string
  /** Data (ISO YYYY-MM-DD) do fechamento desta fatura. */
  closingIso: string
  /** Data (ISO YYYY-MM-DD) do vencimento desta fatura. */
  dueIso: string
  /** Rótulo "outubro/2025" baseado no mês do vencimento. */
  label: string
  /** Chave estável "YYYY-MM" (mês do vencimento). */
  key: string
}

/** Data de fechamento efetiva para um dado ano/mês (respeitando meses curtos). */
export function closingDateFor(card: CreditCard, year: number, month: number): Date {
  return clampDayToMonth(year, month, card.closing_day)
}

/** Data de vencimento efetiva para um dado ano/mês. */
export function dueDateFor(card: CreditCard, year: number, month: number): Date {
  return clampDayToMonth(year, month, card.due_day)
}

/**
 * Determina em que ciclo (fatura) cai uma dada data de compra.
 *
 * Regra: se date <= closingDate(mês da compra) → cai na fatura desse mês.
 * Caso contrário, cai na do mês seguinte.
 * "Fatura de X" usa o mês do vencimento (due_day). Se due_day > closing_day,
 * o vencimento é no MESMO mês do fechamento; se due_day < closing_day, é
 * no mês seguinte.
 */
export function billCycleForDate(card: CreditCard, dateIso: string): CardBillCycle {
  const d = parseISO(dateIso)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const closingThisMonth = closingDateFor(card, y, m)

  const closingIsThisMonth = isBefore(d, closingThisMonth) || isSameDay(d, closingThisMonth)
  const closing = closingIsThisMonth ? closingThisMonth : closingDateFor(card, addMonthsY(y, m, 1).y, addMonthsY(y, m, 1).m)
  const closingY = closing.getFullYear()
  const closingM = closing.getMonth() + 1
  const start = addDays(previousClosing(card, closingY, closingM), 1)

  // Vencimento: no mesmo mês do fechamento se due_day > closing_day; senão mês seguinte.
  const dueSameMonth = card.due_day >= card.closing_day
  const dueYm = dueSameMonth ? { y: closingY, m: closingM } : addMonthsY(closingY, closingM, 1)
  const due = dueDateFor(card, dueYm.y, dueYm.m)

  return {
    card,
    startIso: toIso(start),
    closingIso: toIso(closing),
    dueIso: toIso(due),
    label: monthLabel(due),
    key: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}`,
  }
}

function previousClosing(card: CreditCard, year: number, month: number): Date {
  const prev = addMonthsY(year, month, -1)
  return closingDateFor(card, prev.y, prev.m)
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

function addMonthsY(y: number, m: number, delta: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + delta
  return { y: Math.floor(total / 12), m: (total % 12) + 1 }
}

function toIso(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

const MONTH_NAMES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

function monthLabel(d: Date): string {
  return `${MONTH_NAMES_PT[d.getMonth()]}/${d.getFullYear()}`
}

/** Fatura "atual" = a que ainda está aberta hoje (não fechou). */
export function currentOpenBill(card: CreditCard, today: Date = new Date()): CardBillCycle {
  return billCycleForDate(card, toIso(today))
}

/** Próxima fatura após a atual. */
export function nextBill(card: CreditCard, today: Date = new Date()): CardBillCycle {
  const current = currentOpenBill(card, today)
  const currentClosing = parseISO(current.closingIso)
  const nextAnchor = addDays(currentClosing, 1)
  return billCycleForDate(card, toIso(nextAnchor))
}

/** Soma (cents) de gastos DÉBITO menos estornos (crédito) dentro do ciclo. */
export function sumBillCents(txs: Transaction[], cycle: CardBillCycle): number {
  const start = parseISO(cycle.startIso)
  const end = parseISO(cycle.closingIso)
  let total = 0
  for (const t of txs) {
    if (t.credit_card_id !== cycle.card.id) continue
    const d = parseISO(t.date)
    if (isBefore(d, start) || isAfter(d, end)) continue
    total += t.kind === 'credit' ? -t.amount_cents : t.amount_cents
  }
  return total
}

/** Dias restantes para o próximo evento (fechamento ou vencimento). */
export function daysUntil(iso: string, today: Date = new Date()): number {
  const ms = parseISO(iso).getTime() - startOfDay(today).getTime()
  return Math.max(0, Math.round(ms / 86_400_000))
}

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

export function formatBillShort(cycle: CardBillCycle): string {
  return cycle.label
}

/** Cria "N faturas" a partir do mês atual, indo para o passado ou o futuro. */
export function billHistory(card: CreditCard, count: number, today: Date = new Date()): CardBillCycle[] {
  const list: CardBillCycle[] = []
  let anchor = today
  for (let i = 0; i < count; i++) {
    const cycle = billCycleForDate(card, toIso(anchor))
    list.push(cycle)
    // ancoragem no dia anterior ao início do ciclo → força fatura anterior
    anchor = addDays(parseISO(cycle.startIso), -1)
  }
  return list
}
