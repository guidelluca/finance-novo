import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { supabase } from '@/lib/supabase'
import type { Transaction } from '@/types/database'

export type SummaryRow = Pick<Transaction, 'date' | 'amount_cents' | 'kind'>

export async function fetchAllTransactionSummary(userId: string): Promise<SummaryRow[]> {
  const out: SummaryRow[] = []
  const pageSize = 1000
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('transactions')
      .select('date, amount_cents, kind')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    if (!data?.length) break
    out.push(...(data as SummaryRow[]))
    if (data.length < pageSize) break
    from += pageSize
  }
  return out
}

export function aggregateByMonth(rows: SummaryRow[]) {
  const flowBy = new Map<string, { income: number; expense: number }>()
  for (const t of rows) {
    const k = t.date.slice(0, 7)
    const f = flowBy.get(k) ?? { income: 0, expense: 0 }
    if (t.kind === 'credit') f.income += t.amount_cents
    else f.expense += t.amount_cents
    flowBy.set(k, f)
  }
  const keys = [...flowBy.keys()].sort()
  return keys.map((key) => {
    const f = flowBy.get(key) ?? { income: 0, expense: 0 }
    const d = parseISO(`${key}-01`)
    return {
      key,
      label: format(d, 'MMM yy', { locale: ptBR }),
      labelFull: format(d, 'MMMM yyyy', { locale: ptBR }),
      income: f.income,
      expense: f.expense,
      net: f.income - f.expense,
    }
  })
}

export type FinanceContextPackInput = {
  overview: { income: number; expense: number; net: number; monthCount: number }
  lastMonths: { label: string; net: number; income: number; expense: number }[]
  focusMonth?: {
    label: string
    income: number
    expense: number
    net: number
    categories: { name: string; expenseCents: number }[]
  }
}

/** Texto agregado para o assistente de chat (centavos; não inventar fora disto). */
export function buildFinanceContextPack(i: FinanceContextPackInput): string {
  const lines = [
    `Global: ${i.overview.monthCount} meses com lançamentos; entradas_acumuladas_centavos=${i.overview.income}; saídas_acumuladas_centavos=${i.overview.expense}; líquido_acumulado_centavos=${i.overview.net}.`,
    'Série recente (rótulo; entradas; saídas; líquido; centavos):',
    ...i.lastMonths.map((m) => `- ${m.label}: ${m.income}, ${m.expense}, ${m.net}`),
  ]

  if (i.lastMonths.length >= 1) {
    const tail = i.lastMonths.slice(-3)
    const n = tail.length
    if (n > 0) {
      const avgIn = tail.reduce((s, m) => s + m.income, 0) / n
      const avgOut = tail.reduce((s, m) => s + m.expense, 0) / n
      const avgNet = tail.reduce((s, m) => s + m.net, 0) / n
      lines.push(
        `Últimos ${n} meses da série acima — médias (centavos/mês): entradas≈${Math.round(avgIn)}; saídas≈${Math.round(avgOut)}; líquido≈${Math.round(avgNet)}.`,
      )
    }
  }

  if (i.overview.expense > 0 && i.overview.income > 0) {
    lines.push(
      `No histórico global agregado: despesas/entradas ≈ ${((i.overview.expense / i.overview.income) * 100).toFixed(1)}%; poupança acumulada bruta ≈ ${((i.overview.net / i.overview.income) * 100).toFixed(1)}% das entradas (líquido÷entradas).`,
    )
  }

  if (i.focusMonth) {
    lines.push(
      `Mês em foco (${i.focusMonth.label}): entradas_centavos=${i.focusMonth.income}; saídas_centavos=${i.focusMonth.expense}; líquido_centavos=${i.focusMonth.net}.`,
      'Despesas por categoria neste mês (centavos):',
      ...i.focusMonth.categories.map((c) => `- ${c.name}: ${c.expenseCents}`),
    )

    if (i.focusMonth.expense > 0) {
      const ranked = [...i.focusMonth.categories].sort((a, b) => b.expenseCents - a.expenseCents).slice(0, 10)
      lines.push('Participação das maiores categorias no mês em foco (% sobre saídas do mês):')
      for (const c of ranked) {
        const pct = ((c.expenseCents / i.focusMonth.expense) * 100).toFixed(1)
        lines.push(`- ${c.name}: ${c.expenseCents} centavos (${pct}%)`)
      }
    }

    if (i.focusMonth.income > 0) {
      lines.push(
        `No mês em foco: despesas consomem ≈ ${((i.focusMonth.expense / i.focusMonth.income) * 100).toFixed(1)}% das entradas; sobra bruta ≈ ${((i.focusMonth.net / i.focusMonth.income) * 100).toFixed(1)}% da renda.`,
      )
    }
  }
  return lines.join('\n')
}
