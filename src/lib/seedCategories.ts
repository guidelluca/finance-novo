import { supabase } from '@/lib/supabase'

/** Lista inicial (como chips); todas na raíz — pode editar ou apagar em Categorias. */
export const DEFAULT_CATEGORY_NAMES = [
  'Academia',
  'Auto cuidado',
  'Restaurantes',
  'Contas Mensais',
  'Gasto Desnecessário',
  'Gasto Inevitável',
  'Lanche',
  'Roupas',
  'Saúde',
  'Uber',
  'Lazer',
  'Pix',
  'Salário',
  'Reserva',
  'Ifood',
  'Mercado',
  'VR',
  'Jacareí',
  'Aluguel',
  'Fretado',
  'Aniversário',
  'Presente Allan',
] as const

type RuleSpec = {
  category: (typeof DEFAULT_CATEGORY_NAMES)[number]
  priority: number
  contains?: readonly string[]
  regex?: readonly string[]
}

/** Regras “contains” / “regex” — maior prioridade avaliada primeiro. */
const DEFAULT_RULE_SPECS: RuleSpec[] = [
  { category: 'Uber', priority: 110, contains: ['uber', '99food', '99 food', '99pop'], regex: ['\\b99\\b'] },
  { category: 'Ifood', priority: 105, contains: ['ifood', 'i food', 'i-food', 'IFOOD'] },
  {
    category: 'Mercado',
    priority: 100,
    contains: [
      'supermercado',
      'supermecado',
      'hipermercado',
      'atacadão',
      'atacadao',
      'carrefour',
      'pão de açúcar',
      'pao de acucar',
      'assaí',
      'assai',
      'guanabara',
      'atacado',
      'mercearia',
    ],
  },
  { category: 'Restaurantes', priority: 98, contains: ['restaurante', 'restaurantes', 'lanchonete', 'cantina', 'buffet', 'tip top', 'outback'] },
  { category: 'Lanche', priority: 95, contains: ['lanche', 'padoca', 'padaria', 'coxinha', 'salgado'] },
  { category: 'Academia', priority: 94, contains: ['academia', 'smart fit', 'smartfit', ' gym', 'gym ', 'crossfit', 'bodytech'] },
  { category: 'Salário', priority: 93, contains: ['salário', 'salario', 'folha pagamento', 'depósito de salário', 'deposito de salario'] },
  { category: 'Pix', priority: 92, regex: ['\\bpix\\b'] },
  { category: 'Contas Mensais', priority: 90, contains: ['energia', 'enel', 'cpfl', 'luz ', 'água', 'agua', 'sabesp', 'internet', 'netflix', 'spotify', 'amazon prime', 'disney', 'hbo', 'vivo ', 'tim ', 'claro ', 'oi ', 'mensalidade'] },
  { category: 'Aluguel', priority: 96, contains: ['aluguel', 'condomínio', 'condominio', 'iptu', 'imobiliária', 'imobiliaria'] },
  { category: 'VR', priority: 88, contains: ['vale refeição', 'vale refeicao', 'vr ', 'verocard', 'ticket restaurante', 'pluxee', 'sodexo'] },
  { category: 'Jacareí', priority: 87, contains: ['jacareí', 'jacarei'] },
  { category: 'Auto cuidado', priority: 86, contains: ['barbearia', 'barber', 'manicure', 'estética', 'estetica', 'salão', 'salao'] },
  {
    category: 'Saúde',
    priority: 85,
    contains: [
      'farmácia',
      'farmacia',
      'drogaria',
      'hospital',
      'laboratório',
      'laboratorio',
      'dentista',
      'convênio',
      'convenio',
      'unimed',
      'amil',
    ],
  },
  { category: 'Roupas', priority: 84, contains: ['renner', 'zara', 'cea ', 'c&a', 'hering', ' loja de roupa'] },
  { category: 'Lazer', priority: 83, contains: ['cinema', 'ingresso', 'show ', 'teatro', 'parque ', 'futebol', 'estádio', 'estadio'] },
  { category: 'Reserva', priority: 82, contains: ['resgate rdb', 'poupança', 'poupanca', 'cdb', ' investimento', 'corretora', 'rendimento'] },
  { category: 'Aniversário', priority: 81, contains: ['aniversário', 'aniversario'] },
  { category: 'Presente Allan', priority: 80, contains: ['presente allan'] },
  { category: 'Fretado', priority: 79, contains: ['fretado', ' fretamento', 'van escolar'] },
]

export async function seedDefaultCategoriesIfEmpty(userId: string) {
  const { count, error: cErr } = await supabase
    .from('categories')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  if (cErr) throw cErr
  if (count && count > 0) return

  for (let i = 0; i < DEFAULT_CATEGORY_NAMES.length; i++) {
    const name = DEFAULT_CATEGORY_NAMES[i]!
    const { error } = await supabase.from('categories').insert({
      user_id: userId,
      name,
      parent_id: null,
      sort_order: i,
    })
    if (error) throw error
  }
}

export async function seedDefaultRulesIfEmpty(userId: string) {
  const { count, error: cErr } = await supabase
    .from('rules')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  if (cErr) throw cErr
  if (count && count > 0) return

  const { data: cats, error: catErr } = await supabase
    .from('categories')
    .select('id, name')
    .eq('user_id', userId)

  if (catErr) throw catErr
  const idByName = new Map(
    (cats ?? []).map((c) => [c.name.toLowerCase().trim(), c.id] as const),
  )

  type Ins = {
    user_id: string
    category_id: string
    match_type: 'contains' | 'regex'
    pattern: string
    priority: number
    enabled: boolean
  }

  const rows: Ins[] = []

  for (const spec of DEFAULT_RULE_SPECS) {
    const cid = idByName.get(spec.category.toLowerCase())
    if (!cid) continue
    for (const p of spec.contains ?? []) {
      const pat = p.trim()
      if (pat) rows.push({ user_id: userId, category_id: cid, match_type: 'contains', pattern: pat, priority: spec.priority, enabled: true })
    }
    for (const p of spec.regex ?? []) {
      const pat = p.trim()
      if (pat) rows.push({ user_id: userId, category_id: cid, match_type: 'regex', pattern: pat, priority: spec.priority, enabled: true })
    }
  }

  if (rows.length === 0) return

  const chunk = 80
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supabase.from('rules').insert(rows.slice(i, i + chunk))
    if (error) throw error
  }
}
