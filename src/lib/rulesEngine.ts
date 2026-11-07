import type { Rule } from '@/types/database'

export function suggestCategoryId(
  description: string,
  rules: Rule[],
): string | null {
  const active = rules.filter((r) => r.enabled).sort((a, b) => b.priority - a.priority)
  const d = description.toLowerCase()
  for (const r of active) {
    try {
      if (r.match_type === 'contains' && d.includes(r.pattern.toLowerCase())) {
        return r.category_id
      }
      if (r.match_type === 'equals' && d === r.pattern.toLowerCase()) {
        return r.category_id
      }
      if (r.match_type === 'equals' && description === r.pattern) {
        return r.category_id
      }
      if (r.match_type === 'regex' && new RegExp(r.pattern, 'i').test(description)) {
        return r.category_id
      }
    } catch {
      /* invalid regex */
    }
  }
  return null
}

export function defaultRulePatternFromDescription(description: string): string {
  const tok = description.trim().split(/\s+/).slice(0, 3).join(' ')
  return tok.length > 2 ? tok : description.slice(0, 40)
}
