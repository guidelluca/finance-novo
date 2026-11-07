import type { SupabaseClient } from '@supabase/supabase-js'
import type { Category, Database } from '@/types/database'

function norm(s: string) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
}

/** Sinónimos comuns de exports (ex.: planilha Nubank) → nome de categoria no app. */
const HINT_TO_LABEL: Record<string, string> = {
  alimentacao: 'Restaurantes',
  transporte: 'Uber',
  vestuario: 'Roupas',
  moradia: 'Aluguel',
  assinaturas: 'Contas Mensais',
  financeiro: 'Contas Mensais',
  receita: 'Salário',
  saude: 'Saúde',
  mercado: 'Mercado',
  supermercado: 'Mercado',
  restaurante: 'Restaurantes',
  restaurantes: 'Restaurantes',
  farmacia: 'Saúde',
  uber: 'Uber',
  ifood: 'Ifood',
  pix: 'Pix',
  salario: 'Salário',
  'contas mensais': 'Contas Mensais',
  lazer: 'Lazer',
}

/** Liga texto da coluna Categoria do export a uma categoria existente do utilizador. */
export function resolveImportCategoryHint(
  hint: string | null | undefined,
  categories: Category[],
): string | null {
  const t = hint?.trim()
  if (!t) return null
  const key = norm(t)
  const byExact = categories.find((c) => norm(c.name) === key)
  if (byExact) return byExact.id
  const label = HINT_TO_LABEL[key]
  if (label) {
    const bySyn = categories.find((c) => norm(c.name) === norm(label))
    if (bySyn) return bySyn.id
  }
  return null
}

/**
 * Garante que existem categorias para cada nome único vindo do CSV (Finance PWA).
 * Não duplica se já houver categoria com o mesmo nome (ignorando maiúsculas/acentos).
 */
export async function ensureCategoriesForImportHints(
  client: SupabaseClient<Database>,
  userId: string,
  hints: string[],
): Promise<Category[]> {
  const unique = [...new Set(hints.map((h) => h.trim()).filter(Boolean))]
  const { data: existing, error: selErr } = await client
    .from('categories')
    .select('*')
    .eq('user_id', userId)
  if (selErr) throw selErr
  const cats: Category[] = [...(existing ?? [])]
  let maxSort = cats.reduce((m, c) => Math.max(m, c.sort_order), 0)

  for (const name of unique) {
    if (cats.some((c) => norm(c.name) === norm(name))) continue
    maxSort += 1
    const { data: inserted, error: insErr } = await client
      .from('categories')
      .insert({
        user_id: userId,
        name: name.slice(0, 120),
        sort_order: maxSort,
      })
      .select('*')
      .single()
    if (insErr) throw insErr
    if (inserted) cats.push(inserted as Category)
  }
  return cats
}
