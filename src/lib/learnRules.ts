import { supabase } from '@/lib/supabase'

/**
 * Cria (ou corrige) regras "contém <estabelecimento>" a partir das correções de categoria do usuário,
 * para acertar sozinho nas próximas importações. Melhor esforço: falha aqui não atrapalha o resto.
 * @returns quantas regras foram criadas/atualizadas
 */
export async function learnRules(
  userId: string,
  corrections: { key: string | null | undefined; categoryId: string }[],
): Promise<number> {
  const map = new Map<string, string>()
  for (const c of corrections) {
    const key = c.key?.trim().toLowerCase()
    if (key && key.length >= 4) map.set(key, c.categoryId)
  }
  if (map.size === 0) return 0
  try {
    const { data: existing } = await supabase
      .from('rules')
      .select('id, pattern, category_id')
      .eq('user_id', userId)
      .eq('match_type', 'contains')
    type RuleRow = { id: string; pattern: string; category_id: string }
    const byPattern = new Map<string, RuleRow>(
      ((existing ?? []) as RuleRow[]).map((r) => [r.pattern.toLowerCase(), r]),
    )
    let n = 0
    const inserts: {
      user_id: string
      match_type: 'contains'
      pattern: string
      category_id: string
      priority: number
      enabled: boolean
    }[] = []
    for (const [pattern, category_id] of map) {
      const ex = byPattern.get(pattern)
      if (ex) {
        if (ex.category_id !== category_id) {
          const { error } = await supabase.from('rules').update({ category_id, priority: 150 }).eq('id', ex.id)
          if (!error) n++
        }
      } else {
        inserts.push({ user_id: userId, match_type: 'contains', pattern, category_id, priority: 150, enabled: true })
      }
    }
    if (inserts.length) {
      const { error } = await supabase.from('rules').insert(inserts)
      if (!error) n += inserts.length
    }
    return n
  } catch {
    return 0
  }
}
