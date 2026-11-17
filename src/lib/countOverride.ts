import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/**
 * Lançamentos que você mandou contar mesmo o app achando que não contam
 * (pagamento de fatura, entre contas, aplicação, duplicada, casa…). Fica na sua conta: vale em todos os aparelhos.
 */
export function readForced(user: User | null): string[] {
  const v = user?.user_metadata?.count_force
  return Array.isArray(v) ? (v as string[]) : []
}

/** Junta os "contar mesmo assim" ao conjunto de alertas dispensados (formato que o fechamento entende). */
export function readSkipped(user: User | null): string[] {
  const v = user?.user_metadata?.count_skip
  return Array.isArray(v) ? (v as string[]) : []
}

export function withForced(dismissed: Set<string>, user: User | null): Set<string> {
  const f = readForced(user)
  const k = readSkipped(user)
  if (!f.length && !k.length) return dismissed
  const out = new Set(dismissed)
  for (const id of f) out.add(`force:${id}`)
  for (const id of k) out.add(`skip:${id}`)
  return out
}

export type CountMode = 'auto' | 'conta' | 'nao_conta'

export function countModeOf(user: User | null, txId: string): CountMode {
  if (readForced(user).includes(txId)) return 'conta'
  if (readSkipped(user).includes(txId)) return 'nao_conta'
  return 'auto'
}

/** Automático (o app decide) · Conta (sempre) · Não conta (nunca). */
export async function setCountMode(user: User, txId: string, mode: CountMode): Promise<void> {
  const force = readForced(user).filter((x) => x !== txId)
  const skip = readSkipped(user).filter((x) => x !== txId)
  if (mode === 'conta') force.push(txId)
  if (mode === 'nao_conta') skip.push(txId)
  const { error } = await supabase.auth.updateUser({ data: { count_force: force, count_skip: skip } })
  if (error) throw error
}
