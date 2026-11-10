/**
 * Plano de uma meta com prazo:
 *   - quanto falta e quanto guardar por mês até a data;
 *   - se está no ritmo (comparado com uma linha reta da criação da meta até o prazo);
 *   - gastos JÁ FEITOS para a meta (ex.: passagem da viagem no cartão, parcelada):
 *       pago  = parcelas que já saíram do seu dinheiro → a meta andou, mas esse dinheiro NÃO está guardado;
 *       a pagar = parcelas futuras → já está comprometido; diminui o que falta juntar, mas pesa nos próximos meses;
 *   - onde cortar para fechar a diferença (categorias com gasto alto e não essenciais).
 * Os lançamentos ligados à meta vêm das palavras-chave dela (nome do lugar, companhia aérea, hotel…).
 */
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export type GoalMeta = { keywords: string[]; exclude: string[] }
export type LinkedTx = { id: string; date: string; amountCents: number; description: string; kind: 'debit' | 'credit' }

/** Palavras-chave padrão para metas de viagem (companhias, hotéis, agências). */
export const TRAVEL_KEYWORDS = [
  'latam', 'gol linhas', 'voegol', 'azul linhas', 'tap air', 'iberia', 'air france', 'klm', 'lufthansa', 'ryanair', 'easyjet', 'vueling', 'ita airways',
  'booking', 'airbnb', 'hoteis', 'hotel', 'hostel', 'decolar', 'cvc', '123milhas', 'maxmilhas', 'smiles', 'latam pass', 'passagem',
]

export function readGoalMeta(user: User | null, goalId: string, goalName: string): GoalMeta {
  const raw = (user?.user_metadata?.goal_meta ?? {}) as Record<string, Partial<GoalMeta>>
  const m = raw[goalId]
  if (m && Array.isArray(m.keywords)) return { keywords: m.keywords, exclude: Array.isArray(m.exclude) ? m.exclude : [] }
  // sem configuração: meta de viagem já começa procurando passagens e hospedagem
  return { keywords: /viag|trip|europa|f[eé]rias|passage|interc[aâ]mbio/i.test(goalName) ? TRAVEL_KEYWORDS : [], exclude: [] }
}

export async function saveGoalMeta(user: User, goalId: string, meta: GoalMeta): Promise<void> {
  const raw = { ...((user.user_metadata?.goal_meta ?? {}) as Record<string, GoalMeta>) }
  raw[goalId] = meta
  const { error } = await supabase.auth.updateUser({ data: { goal_meta: raw } })
  if (error) throw error
}

/** Lançamentos de gasto (12 meses para trás e parcelas futuras) cujo texto tem alguma palavra-chave. */
export async function fetchLinkedTxs(userId: string, keywords: string[], since: string): Promise<LinkedTx[]> {
  const kws = keywords.map((k) => k.trim().replace(/[%,()]/g, ' ').trim()).filter((k) => k.length >= 3)
  if (!kws.length) return []
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount_cents, description_raw, kind')
    .eq('user_id', userId)
    .gte('date', since)
    .or(kws.map((k) => `description_raw.ilike.%${k}%`).join(','))
    .order('date')
    .limit(500)
  if (error) throw error
  return ((data ?? []) as { id: string; date: string; amount_cents: number; description_raw: string; kind: 'debit' | 'credit' }[]).map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amount_cents,
    description: r.description_raw,
    kind: r.kind,
  }))
}

const ym = (iso: string) => iso.slice(0, 7)
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number]
  const [by, bm] = b.split('-').map(Number) as [number, number]
  return (by - ay) * 12 + (bm - am)
}
function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const f = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate()
  return `${f.getUTCFullYear()}-${String(f.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

export type Installment = { name: string; perMonthCents: number; paid: number; total: number; lastMonth: string; futureCents: number }

export type GoalPlan = {
  monthsLeft: number
  /** já saiu do seu dinheiro para a meta (compras e parcelas pagas até hoje) */
  paidCents: number
  /** parcelas futuras já compradas para a meta */
  committedCents: number
  installments: Installment[]
  /** parcelas a pagar no próximo mês (peso no orçamento) */
  nextMonthInstallmentsCents: number
  /** o que ainda falta juntar em dinheiro */
  remainingCashCents: number
  /** quanto guardar por mês até o prazo */
  perMonthCents: number
  /** quanto deveria ter coberto até hoje no ritmo de uma linha reta */
  expectedByNowCents: number
  /** guardado + pago + comprometido */
  coveredCents: number
  status: 'atingida' | 'adiantado' | 'no_ritmo' | 'atrasado' | 'sem_prazo'
  /** quanto está atrás (status atrasado) ou à frente (adiantado) */
  gapCents: number
  /** guardado este mês × o que precisava */
  savedThisMonthCents: number
}

/**
 * Parcelas: "LATAM (parcela 2/10)". Para cada compra (nome base + total de parcelas), as que já existem
 * contam (pagas se a data já passou, a pagar se é futura) e as que ainda não foram importadas são
 * deduzidas: mesmo valor, uma por mês depois da última conhecida.
 */
export function planGoal(input: {
  targetCents: number | null
  savedCents: number
  savedThisMonthCents: number
  createdAt: string
  deadline: string | null // YYYY-MM
  today: string
  linked: LinkedTx[]
}): GoalPlan {
  const { today } = input
  const debits = input.linked.filter((t) => t.kind === 'debit')
  const refunds = input.linked.filter((t) => t.kind === 'credit').reduce((a, t) => a + t.amountCents, 0)

  const groups = new Map<string, { name: string; total: number; rows: { k: number; date: string; cents: number }[] }>()
  let paidCents = 0
  let committedCents = 0
  for (const t of debits) {
    const m = t.description.match(/^(.*?)\s*\(?\s*parcela\s+(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\s*\)?\s*$/i)
    if (!m) {
      if (t.date <= today) paidCents += t.amountCents
      else committedCents += t.amountCents
      continue
    }
    const name = m[1]!.replace(/\*/g, ' ').replace(/\s+/g, ' ').trim()
    const total = Number(m[3])
    const key = `${name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14)}|${total}`
    const g = groups.get(key) ?? { name, total, rows: [] }
    if (!g.rows.some((r) => r.k === Number(m[2]))) g.rows.push({ k: Number(m[2]), date: t.date, cents: t.amountCents })
    groups.set(key, g)
  }
  const installments: Installment[] = []
  let nextMonthInstallmentsCents = 0
  const nextYm = ym(addMonthsIso(`${ym(today)}-01`, 1))
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.k - b.k)
    let paid = 0
    let future = 0
    const schedule: { date: string; cents: number }[] = g.rows.map((r) => ({ date: r.date, cents: r.cents }))
    // parcelas anteriores à primeira importada (ex.: só a 3/10 está no app): já foram pagas
    const first = g.rows[0]!
    for (let k = 1; k < first.k; k++) schedule.unshift({ date: addMonthsIso(first.date, k - first.k), cents: first.cents })
    const last = g.rows[g.rows.length - 1]!
    for (let k = last.k + 1; k <= g.total; k++) schedule.push({ date: addMonthsIso(last.date, k - last.k), cents: last.cents })
    for (const s of schedule) {
      if (s.date <= today) {
        paid += 1
        paidCents += s.cents
      } else {
        future += s.cents
        committedCents += s.cents
        if (ym(s.date) === nextYm) nextMonthInstallmentsCents += s.cents
      }
    }
    installments.push({
      name: g.name,
      perMonthCents: last.cents,
      paid,
      total: g.total,
      lastMonth: ym(schedule[schedule.length - 1]!.date),
      futureCents: future,
    })
  }
  paidCents = Math.max(0, paidCents - refunds)

  const target = input.targetCents ?? 0
  const covered = input.savedCents + paidCents + committedCents
  const remainingCashCents = Math.max(0, target - covered)
  const nowYm = ym(today)
  const monthsLeft = input.deadline ? Math.max(1, monthsBetween(nowYm, input.deadline)) : 0
  const perMonthCents = input.deadline ? Math.ceil(remainingCashCents / monthsLeft) : 0

  let expectedByNowCents = 0
  let status: GoalPlan['status'] = 'sem_prazo'
  let gapCents = 0
  if (target && covered >= target) status = 'atingida'
  else if (target && input.deadline) {
    const start = ym(input.createdAt)
    const span = Math.max(1, monthsBetween(start, input.deadline))
    const elapsed = Math.min(span, Math.max(0, monthsBetween(start, nowYm) + 1))
    expectedByNowCents = Math.round((target * elapsed) / span)
    const diff = covered - expectedByNowCents
    const tol = target * 0.03
    status = diff > tol ? 'adiantado' : diff >= -tol ? 'no_ritmo' : 'atrasado'
    gapCents = Math.abs(diff)
  }
  return {
    monthsLeft,
    paidCents,
    committedCents,
    installments: installments.sort((a, b) => b.futureCents - a.futureCents),
    nextMonthInstallmentsCents,
    remainingCashCents,
    perMonthCents,
    expectedByNowCents,
    coveredCents: covered,
    status,
    gapCents,
    savedThisMonthCents: input.savedThisMonthCents,
  }
}

/** Categorias que dá para enxugar (não entram aluguel, contas, saúde, mercado, salário…). */
const ESSENTIAL = /aluguel|moradia|casa|contas|saude|sa[uú]de|farm|mercado|supermerc|educa|salario|sal[aá]rio|reserva|invest|imposto|tarifa|taxa|transporte p|fretado|inevit/i

export type Cut = { name: string; avgCents: number; cutCents: number; pct: number }

/** Cortes de 20–30% nas categorias não essenciais de maior gasto até cobrir a diferença mensal. */
export function suggestCuts(cats: { name: string; avgCents: number }[], neededPerMonthCents: number): Cut[] {
  if (neededPerMonthCents <= 0) return []
  const pool = cats.filter((c) => c.avgCents >= 5_000 && !ESSENTIAL.test(c.name)).sort((a, b) => b.avgCents - a.avgCents)
  const out: Cut[] = []
  let left = neededPerMonthCents
  for (const c of pool) {
    if (left <= 0 || out.length >= 4) break
    const pct = c.avgCents >= 50_000 ? 30 : 20
    const cut = Math.min(left, Math.round((c.avgCents * pct) / 100))
    out.push({ name: c.name, avgCents: c.avgCents, cutCents: cut, pct: Math.round((cut / c.avgCents) * 100) })
    left -= cut
  }
  return out
}
