import { format, subDays } from 'date-fns'
import { supabase } from '@/lib/supabase'

const WINDOW_DAYS = 90
const TOP_DEBIT_LINES = 22
const TOP_CATEGORY_LINES = 14
const DESC_MAX = 68
const PAGE = 800

type DebitRow = {
  amount_cents: number
  categories: { name: string } | null
}

function clipDesc(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= DESC_MAX) return t
  return `${t.slice(0, DESC_MAX - 1)}…`
}

/**
 * Snapshot puxado da base no momento do pedido ao chat: maiores débitos e ranking de categorias
 * numa janela recente (evita respostas da IA sem ligação aos lançamentos reais).
 */
export async function fetchFinanceAiLiveSnapshot(userId: string): Promise<string> {
  const from = format(subDays(new Date(), WINDOW_DAYS), 'yyyy-MM-dd')

  const { data: topList, error: err1 } = await supabase
    .from('transactions')
    .select('date, amount_cents, description_raw, categories(name)')
    .eq('user_id', userId)
    .eq('kind', 'debit')
    .gte('date', from)
    .order('amount_cents', { ascending: false })
    .limit(TOP_DEBIT_LINES)

  if (err1) {
    return `Nota: não foi possível carregar os maiores débitos (${err1.message}).`
  }

  const byCat = new Map<string, number>()
  let offset = 0
  for (;;) {
    const { data: chunk, error: err2 } = await supabase
      .from('transactions')
      .select('amount_cents, categories(name)')
      .eq('user_id', userId)
      .eq('kind', 'debit')
      .gte('date', from)
      .range(offset, offset + PAGE - 1)

    if (err2) {
      return `Nota: não foi possível agregar categorias (${err2.message}).`
    }
    if (!chunk?.length) break

    for (const row of chunk as DebitRow[]) {
      const name = row.categories?.name?.trim() || 'Sem categoria'
      byCat.set(name, (byCat.get(name) ?? 0) + row.amount_cents)
    }
    if (chunk.length < PAGE) break
    offset += PAGE
    if (offset > 50_000) break
  }

  const catRank = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORY_LINES)

  const totalWindow = catRank.reduce((s, [, c]) => s + c, 0)

  const lines: string[] = [
    `Janela: últimos ${WINDOW_DAYS} dias (a partir de ${from}). Total despesas (soma categorias) em centavos: ${totalWindow}.`,
    'Maiores débitos individuais (data; centavos; categoria; descrição):',
  ]

  for (const row of topList ?? []) {
    const r = row as {
      date: string
      amount_cents: number
      description_raw: string
      categories: { name: string } | null
    }
    const cat = r.categories?.name?.trim() || 'Sem categoria'
    lines.push(`- ${r.date} | ${r.amount_cents} | ${cat} | ${clipDesc(r.description_raw)}`)
  }

  if (catRank.length) {
    lines.push(`Despesas por categoria nesta janela (centavos; % sobre total da janela):`)
    for (const [name, cents] of catRank) {
      const pct = totalWindow > 0 ? ((cents / totalWindow) * 100).toFixed(1) : '0'
      lines.push(`- ${name}: ${cents} (${pct}%)`)
    }
  }

  return lines.join('\n')
}
