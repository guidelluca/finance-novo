/**
 * Limites do orçamento (total do mês e por categoria) e prazos de metas,
 * guardados no perfil do usuário no Supabase (auth user_metadata):
 * sincroniza entre aparelhos e não precisa de tabela nova.
 */
import type { User } from '@supabase/supabase-js'
import { parseMoneyToCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'

export type Budgets = {
  /** limite total do mês (centavos); null = soma dos limites por categoria */
  total: number | null
  /** categoryId → limite mensal (centavos) */
  byCategory: Record<string, number>
}

export function readBudgets(user: User | null | undefined): Budgets {
  const raw = (user?.user_metadata?.budgets ?? {}) as Partial<Budgets>
  const byCategory: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw.byCategory ?? {})) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) byCategory[k] = Math.round(n)
  }
  const total = raw.total != null && Number(raw.total) > 0 ? Math.round(Number(raw.total)) : null
  return { total, byCategory }
}

export function effectiveTotal(b: Budgets): number {
  return b.total ?? Object.values(b.byCategory).reduce((s, v) => s + v, 0)
}

export async function saveBudgets(b: Budgets): Promise<string | null> {
  const { error } = await supabase.auth.updateUser({ data: { budgets: b } })
  return error ? error.message : null
}

/** goalId → 'YYYY-MM' */
export function readGoalDeadlines(user: User | null | undefined): Record<string, string> {
  const raw = (user?.user_metadata?.goal_deadlines ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) out[k] = v
  return out
}

export async function saveGoalDeadline(
  user: User | null | undefined,
  goalId: string,
  month: string | null,
): Promise<string | null> {
  const cur = readGoalDeadlines(user)
  if (month) cur[goalId] = month
  else delete cur[goalId]
  const { error } = await supabase.auth.updateUser({ data: { goal_deadlines: cur } })
  return error ? error.message : null
}

export function parseBRLToCents(v: string): number | null {
  const c = parseMoneyToCents(v)
  return c == null || c < 0 ? null : c
}
