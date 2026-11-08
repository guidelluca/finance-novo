import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/**
 * Mês financeiro: começa no dia em que cai o salário do fim do mês (penúltimo dia útil),
 * não no dia 1. Ex.: salário em 29/10 → de 29/10 em diante já é "novembro".
 * O dia exato vem do salário de verdade quando ele está no extrato; senão, o penúltimo dia útil.
 */
export type MonthMode = 'salario' | 'calendario'

export const SALARY_RE = /remunera[cç][aã]o|sal[aá]rio|folha de pag|pagto\.? sal|cr[eé]dito sal/i

export function readMonthMode(user: User | null): MonthMode {
  return user?.user_metadata?.month_mode === 'calendario' ? 'calendario' : 'salario'
}

export async function saveMonthMode(mode: MonthMode): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: { month_mode: mode } })
  if (error) throw error
}

function iso(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10)
}

export function addDaysIso(d: string, n: number): string {
  const x = new Date(`${d}T12:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

export function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return iso(y, m - 1 + delta, 1).slice(0, 7)
}

/** Penúltimo dia útil (seg–sex) do mês do calendário. */
export function penultimateBusinessDay(calMonth: string): string {
  const [y, m] = calMonth.split('-').map(Number) as [number, number]
  let d = new Date(Date.UTC(y, m, 0))
  let found = 0
  for (;;) {
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) {
      found += 1
      if (found === 2) return d.toISOString().slice(0, 10)
    }
    d = new Date(d.getTime() - 86_400_000)
  }
}

export type Periods = {
  mode: MonthMode
  /** 1.º dia do mês financeiro M */
  startOf: (month: string) => string
  /** intervalo (inclusivo) do mês financeiro M */
  rangeOf: (month: string) => { start: string; end: string }
  /** mês financeiro ao qual uma data pertence */
  periodOf: (date: string) => string
}

/** anchors = datas de créditos de salário (qualquer dia; só os do fim do mês importam). */
export function makePeriods(mode: MonthMode, anchors: string[]): Periods {
  if (mode === 'calendario') {
    const startOf = (month: string) => `${month}-01`
    return {
      mode,
      startOf,
      rangeOf: (month) => ({ start: startOf(month), end: addDaysIso(startOf(shiftMonthKey(month, 1)), -1) }),
      periodOf: (date) => date.slice(0, 7),
    }
  }
  const sorted = [...new Set(anchors)].sort()
  const cache = new Map<string, string>()
  const startOf = (month: string): string => {
    const hit = cache.get(month)
    if (hit) return hit
    const def = penultimateBusinessDay(shiftMonthKey(month, -1))
    const lo = addDaysIso(def, -4)
    const hi = addDaysIso(def, 3)
    // salário real mais perto do penúltimo dia útil, se estiver no extrato
    let best: string | null = null
    for (const a of sorted) {
      if (a < lo || a > hi) continue
      const dist = Math.abs(Date.parse(a) - Date.parse(def))
      if (best === null || dist < Math.abs(Date.parse(best) - Date.parse(def))) best = a
    }
    const s = best ?? def
    cache.set(month, s)
    return s
  }
  return {
    mode,
    startOf,
    rangeOf: (month) => ({ start: startOf(month), end: addDaysIso(startOf(shiftMonthKey(month, 1)), -1) }),
    periodOf: (date) => {
      const cal = date.slice(0, 7)
      const next = shiftMonthKey(cal, 1)
      if (date >= startOf(next)) return next
      if (date < startOf(cal)) return shiftMonthKey(cal, -1)
      return cal
    },
  }
}

/** Datas dos salários (créditos), últimos ~3 anos. */
export async function fetchSalaryAnchors(userId: string): Promise<string[]> {
  const from = iso(new Date().getUTCFullYear() - 3, 0, 1)
  const { data, error } = await supabase
    .from('transactions')
    .select('date, description_raw')
    .eq('user_id', userId)
    .eq('kind', 'credit')
    .gte('date', from)
    .or('description_raw.ilike.%salario%,description_raw.ilike.%salário%,description_raw.ilike.%remunera%,description_raw.ilike.%folha de pag%')
    .limit(1000)
  if (error) return []
  return ((data ?? []) as { date: string; description_raw: string }[])
    .filter((r) => SALARY_RE.test(r.description_raw))
    .map((r) => r.date)
}
