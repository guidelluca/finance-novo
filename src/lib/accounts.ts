import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/** Conta ou cartão que o usuário quer acompanhar todo mês. */
export type TrackedAccount = { id: string; name: string; kind: 'conta' | 'cartao' }

export const DEFAULT_ACCOUNTS: TrackedAccount[] = [
  { id: 'itau', name: 'Itaú', kind: 'conta' },
  { id: 'itau-cartao', name: 'Cartão Itaú', kind: 'cartao' },
  { id: 'nubank', name: 'Nubank', kind: 'conta' },
  { id: 'mercadopago', name: 'Mercado Pago', kind: 'conta' },
  { id: 'picpay', name: 'PicPay', kind: 'conta' },
  { id: 'picpay-cartao', name: 'Cartão PicPay', kind: 'cartao' },
  { id: 'inter', name: 'Banco Inter', kind: 'conta' },
]

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Palavra que identifica o banco no nome da conta ("Banco Inter" → "inter", "Cartão Itaú" → "itau"). */
function bankKey(name: string): string {
  const f = fold(name).replace(/\b(cartao|cartão|de|credito|conta|banco|bco|corrente)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^nu(bank)?$|nu pagamentos/.test(f)) return 'nubank'
  if (/mercado ?pago/.test(f)) return 'mercado pago'
  return f
}

const CARD_HINT = /cart[aã]o|cr[eé]dito|fatura/i

export function readAccounts(user: User | null): TrackedAccount[] {
  const raw = user?.user_metadata?.tracked_accounts
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.filter((a): a is TrackedAccount => a && typeof a.id === 'string' && typeof a.name === 'string')
  }
  return DEFAULT_ACCOUNTS
}

export async function saveAccounts(list: TrackedAccount[]): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: { tracked_accounts: list } })
  if (error) throw error
}

/** A qual conta acompanhada pertence um lançamento (pelo campo "conta" e por estar ligado a um cartão). */
export function matchAccount(
  accounts: TrackedAccount[],
  label: string | null | undefined,
  hasCard = false,
): TrackedAccount | null {
  if (!label && !hasCard) return null
  const isCard = hasCard || CARD_HINT.test(label ?? '')
  const l = fold(label ?? '')
  const exact = accounts.find((a) => fold(a.name) === l && (a.kind === 'cartao') === isCard)
  if (exact) return exact
  const key = bankKey(label ?? '')
  const candidates = accounts.filter((a) => {
    const k = bankKey(a.name)
    return k.length >= 3 && (l.includes(k) || (key.length >= 3 && k.includes(key)))
  })
  return candidates.find((a) => (a.kind === 'cartao') === isCard) ?? (candidates.length === 1 ? candidates[0]! : null)
}

/** Marcações manuais: "{mês}:{conta}" → completo (ex.: sem movimento depois do último lançamento). */
export function readCoverageMarks(user: User | null): Record<string, boolean> {
  const raw = user?.user_metadata?.coverage_ok
  return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
}

export async function setCoverageMark(user: User, month: string, accountId: string, ok: boolean): Promise<void> {
  const cur = { ...readCoverageMarks(user) }
  const key = `${month}:${accountId}`
  if (ok) cur[key] = true
  else delete cur[key]
  const { error } = await supabase.auth.updateUser({ data: { coverage_ok: cur } })
  if (error) throw error
}

export type CoverageStatus = 'completo' | 'parcial' | 'falta' | 'em_andamento'

export type AccountCoverage = {
  account: TrackedAccount
  status: CoverageStatus
  /** dias do mês cobertos por algum arquivo importado (ISO) */
  coveredFrom: string | null
  coveredTo: string | null
  count: number
  manual: boolean
  /** trechos do mês sem nenhum arquivo importado */
  gaps: { from: string; to: string }[]
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  return { start: `${month}-01`, end }
}

export type CoverageTx = { date: string; account: string | null; credit_card_id: string | null; import_batch_id: string | null }

/**
 * Cobertura do mês por conta: cada arquivo importado cobre do 1.º ao último lançamento dele.
 * Tolerância de 4 dias nas pontas (dias sem movimento no começo/fim do mês são normais).
 */
export function computeCoverage(
  month: string,
  accounts: TrackedAccount[],
  txs: CoverageTx[],
  today: string,
  marks: Record<string, boolean>,
  /** mês financeiro (ex.: 29/10–26/11); sem isso, mês do calendário */
  bounds?: { start: string; end: string },
): AccountCoverage[] {
  const { start, end } = bounds ?? monthBounds(month)
  const inProgress = today < end
  const until = inProgress ? today : end
  const TOL = 4

  return accounts.map((account) => {
    const mine = txs.filter((t) => matchAccount(accounts, t.account, Boolean(t.credit_card_id))?.id === account.id)
    const byBatch = new Map<string, { min: string; max: string }>()
    let count = 0
    for (const t of mine) {
      if (t.date >= start && t.date <= end) count += 1
      const k = t.import_batch_id ?? `manual:${t.date}`
      const r = byBatch.get(k)
      if (!r) byBatch.set(k, { min: t.date, max: t.date })
      else {
        if (t.date < r.min) r.min = t.date
        if (t.date > r.max) r.max = t.date
      }
    }
    // intervalos dos arquivos, recortados ao mês, unidos
    const ranges = [...byBatch.values()]
      .map((r) => ({ from: r.min < start ? start : r.min, to: r.max > end ? end : r.max }))
      .filter((r) => r.from <= r.to && r.to >= start && r.from <= end)
      .sort((a, b) => (a.from < b.from ? -1 : 1))
    const merged: { from: string; to: string }[] = []
    for (const r of ranges) {
      const last = merged[merged.length - 1]
      if (last && r.from <= addDays(last.to, TOL)) {
        if (r.to > last.to) last.to = r.to
      } else merged.push({ ...r })
    }
    const gaps: { from: string; to: string }[] = []
    let cursor = start
    for (const r of merged) {
      if (r.from > addDays(cursor, TOL)) gaps.push({ from: cursor, to: addDays(r.from, -1) })
      if (addDays(r.to, 1) > cursor) cursor = addDays(r.to, 1)
    }
    if (cursor <= addDays(until, -TOL)) gaps.push({ from: cursor, to: until })

    const manual = Boolean(marks[`${month}:${account.id}`])
    let status: CoverageStatus
    if (manual) status = 'completo'
    else if (inProgress && account.kind === 'cartao') status = 'em_andamento' // fatura ainda não fechou
    else if (merged.length === 0) status = 'falta'
    else if (gaps.length === 0) status = inProgress ? 'em_andamento' : 'completo'
    else status = 'parcial'
    return {
      account,
      status,
      coveredFrom: merged[0]?.from ?? null,
      coveredTo: merged[merged.length - 1]?.to ?? null,
      count,
      manual,
      gaps,
    }
  })
}

/** Lançamentos de 2 meses antes a 2 depois (um arquivo pode cobrir vários meses). */
export async function fetchCoverageTxs(userId: string, month: string): Promise<CoverageTx[]> {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const from = new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 10)
  const to = new Date(Date.UTC(y, m + 2, 0)).toISOString().slice(0, 10)
  const out: CoverageTx[] = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('date, account, credit_card_id, import_batch_id')
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('id')
      .range(i, i + 999)
    if (error) throw error
    out.push(...((data ?? []) as CoverageTx[]))
    if (!data || data.length < 1000) break
  }
  return out
}
