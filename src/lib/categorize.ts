/**
 * Categoria automática de um lançamento, do sinal mais forte para o mais fraco:
 *   1. regra aprendida com as suas correções (prioridade ≥ 150);
 *   2. estabelecimento conhecido (iFood, Dalben, "BAR", "PADARIA"…) → a sua categoria com esse nome;
 *   3. memória: o mesmo estabelecimento já foi categorizado por você antes → a mesma categoria;
 *   4. regras gerais (as iniciais do app);
 *   5. categoria impressa pelo banco/app;
 *   6. gasto no VR (Alelo) sem nada acima → Alimentação.
 *
 * Também monta a árvore Alimentação → Mercado, Restaurante, Bar, iFood, Lanche e café, Padaria,
 * reaproveitando as categorias que você já tem (Restaurantes, Ifood, Lanche, Mercado).
 */
import type { User } from '@supabase/supabase-js'
import { identifyMerchant, pickCategoryId } from '@/lib/merchantIdentify'
import { suggestCategoryId } from '@/lib/rulesEngine'
import { supabase } from '@/lib/supabase'
import type { Category, Rule } from '@/types/database'

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()

export const LEARNED_PRIORITY = 150

/** Chave do estabelecimento para a memória ("SUPERMERCADOS DALBEN" e "Supermercados Dalben" juntos). */
export function merchantKey(description: string): string {
  return norm(identifyMerchant(description).name).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)
}

export type MerchantMemory = Map<string, string>

/** Para cada estabelecimento, a categoria que você mais usou nele. */
export function buildMerchantMemory(rows: { description_raw: string; category_id: string | null }[]): MerchantMemory {
  const count = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!r.category_id) continue
    const k = merchantKey(r.description_raw)
    if (!k || k.length < 3) continue
    const m = count.get(k) ?? new Map<string, number>()
    m.set(r.category_id, (m.get(r.category_id) ?? 0) + 1)
    count.set(k, m)
  }
  const out: MerchantMemory = new Map()
  for (const [k, m] of count) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]
    if (best) out.set(k, best[0])
  }
  return out
}

export async function loadMerchantMemory(userId: string): Promise<MerchantMemory> {
  const rows: { description_raw: string; category_id: string | null }[] = []
  for (let i = 0; i < 6000; i += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('description_raw, category_id')
      .eq('user_id', userId)
      .not('category_id', 'is', null)
      .order('date', { ascending: false })
      .range(i, i + 999)
    if (error || !data?.length) break
    rows.push(...(data as typeof rows))
    if (data.length < 1000) break
  }
  return buildMerchantMemory(rows)
}

export type Suggestion = { categoryId: string | null; source: 'regra' | 'estabelecimento' | 'memoria' | 'regra_geral' | 'banco' | 'vr' | null }

export function suggestCategory(
  t: { description: string; account?: string | null; hint?: string | null },
  ctx: { rules: Rule[]; categories: Pick<Category, 'id' | 'name' | 'parent_id'>[]; memory?: MerchantMemory },
): Suggestion {
  const learned = ctx.rules.filter((r) => r.enabled && r.priority >= LEARNED_PRIORITY)
  const general = ctx.rules.filter((r) => r.enabled && r.priority < LEARNED_PRIORITY)
  const r1 = suggestCategoryId(t.description, learned)
  if (r1) return { categoryId: r1, source: 'regra' }
  const m = identifyMerchant(t.description)
  const r2 = pickCategoryId(m.categories, ctx.categories)
  if (r2) return { categoryId: r2, source: 'estabelecimento' }
  const k = merchantKey(t.description)
  const r3 = k ? ctx.memory?.get(k) : undefined
  if (r3 && ctx.categories.some((c) => c.id === r3)) return { categoryId: r3, source: 'memoria' }
  const r4 = suggestCategoryId(t.description, general)
  if (r4) return { categoryId: r4, source: 'regra_geral' }
  if (t.hint) {
    const r5 = ctx.categories.find((c) => norm(c.name) === norm(t.hint!))
    if (r5) return { categoryId: r5.id, source: 'banco' }
  }
  if (/alelo|\bvr\b|vale.?refei/i.test(t.account ?? '')) {
    const food = ctx.categories.find((c) => /^alimenta/.test(norm(c.name)) && !c.parent_id)
    if (food) return { categoryId: food.id, source: 'vr' }
  }
  return { categoryId: null, source: null }
}

/* ---------------------------------------------------------------- árvore Alimentação */

const FOOD_PARENT = ['Alimentação', 'Alimentacao', 'Comida']
const FOOD_CHILDREN: { name: string; synonyms: string[] }[] = [
  { name: 'Mercado', synonyms: ['Mercado', 'Supermercado'] },
  { name: 'Restaurantes', synonyms: ['Restaurantes', 'Restaurante'] },
  { name: 'Bar', synonyms: ['Bar', 'Bares'] },
  { name: 'Ifood', synonyms: ['Ifood', 'iFood', 'Delivery'] },
  { name: 'Lanche', synonyms: ['Lanche', 'Lanches', 'Lanche e café', 'Café'] },
  { name: 'Padaria', synonyms: ['Padaria'] },
]

/** Cria/organiza Alimentação e as subcategorias (uma vez por conta). Devolve true se mexeu em algo. */
export async function ensureFoodTree(user: User): Promise<boolean> {
  if (user.user_metadata?.food_tree_v1) return false
  const { data, error } = await supabase.from('categories').select('*').eq('user_id', user.id)
  if (error) throw error
  const cats = (data ?? []) as Category[]
  const find = (names: string[]) => cats.find((c) => names.some((n) => norm(n) === norm(c.name)))
  let parent = find(FOOD_PARENT)
  if (!parent) {
    const { data: ins, error: e } = await supabase
      .from('categories')
      .insert({ user_id: user.id, name: 'Alimentação', parent_id: null, sort_order: 0 })
      .select('*')
      .single()
    if (e) throw e
    parent = ins as Category
  } else if (parent.parent_id) {
    await supabase.from('categories').update({ parent_id: null }).eq('id', parent.id)
  }
  for (const [i, child] of FOOD_CHILDREN.entries()) {
    const ex = find(child.synonyms)
    if (ex) {
      if (ex.parent_id !== parent.id) await supabase.from('categories').update({ parent_id: parent.id }).eq('id', ex.id)
    } else {
      await supabase.from('categories').insert({ user_id: user.id, name: child.name, parent_id: parent.id, sort_order: i + 1 })
    }
  }
  await supabase.auth.updateUser({ data: { food_tree_v1: true } })
  return true
}

/* ---------------------------------------------------------------- categorizar o que já existe */

type TxRow = { id: string; description_raw: string; category_id: string | null; account: string | null }

/**
 * Passa a categorização automática nos lançamentos já gravados (últimos 12 meses):
 *   - sem categoria → recebe a sugestão;
 *   - na categoria geral "Alimentação" ou numa subcategoria de comida → vai para a subcategoria
 *     que o estabelecimento indica (ex.: "BONJOUR BARAO BAR" em Restaurantes → Bar),
 *     a não ser que uma regra aprendida com você diga outra coisa.
 * Não mexe em nada fora de comida que você já categorizou.
 */
export async function autoCategorizeExisting(userId: string, since: string): Promise<{ filled: number; moved: number }> {
  const [{ data: cData }, { data: rData }] = await Promise.all([
    supabase.from('categories').select('*').eq('user_id', userId),
    supabase.from('rules').select('*').eq('user_id', userId),
  ])
  const categories = (cData ?? []) as Category[]
  const rules = ((rData ?? []) as Rule[]).filter((r) => r.enabled)
  const food = categories.find((c) => /^alimenta/.test(norm(c.name)) && !c.parent_id)
  const foodIds = new Set(categories.filter((c) => food && (c.id === food.id || c.parent_id === food.id)).map((c) => c.id))

  const rows: TxRow[] = []
  for (let i = 0; i < 20000; i += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, description_raw, category_id, account')
      .eq('user_id', userId)
      .eq('kind', 'debit')
      .gte('date', since)
      .order('id')
      .range(i, i + 999)
    if (error) throw error
    rows.push(...((data ?? []) as TxRow[]))
    if (!data || data.length < 1000) break
  }
  const memory = buildMerchantMemory(rows)
  const learned = rules.filter((r) => r.priority >= LEARNED_PRIORITY)
  const updates = new Map<string, string[]>()
  let filled = 0
  let moved = 0
  for (const t of rows) {
    if (!t.category_id) {
      const s = suggestCategory({ description: t.description_raw, account: t.account }, { rules, categories, memory })
      if (s.categoryId) {
        updates.set(s.categoryId, [...(updates.get(s.categoryId) ?? []), t.id])
        filled += 1
      }
      continue
    }
    if (!foodIds.has(t.category_id) || suggestCategoryId(t.description_raw, learned)) continue
    const target = pickCategoryId(identifyMerchant(t.description_raw).categories, categories)
    if (target && target !== t.category_id && foodIds.has(target)) {
      updates.set(target, [...(updates.get(target) ?? []), t.id])
      moved += 1
    }
  }
  for (const [categoryId, ids] of updates) {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await supabase
        .from('transactions')
        .update({ category_id: categoryId })
        .eq('user_id', userId)
        .in('id', ids.slice(i, i + 100))
      if (error) throw error
    }
  }
  return { filled, moved }
}
