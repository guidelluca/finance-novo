import { financeLlmGenerateJson, financeLlmGenerateText } from '@/lib/financeLlm'

export type FinanceInsightsInput = {
  locale: 'pt-BR'
  mode: 'overview' | 'month'
  monthLabel?: string
  totals: { incomeCents: number; expenseCents: number; netCents: number }
  categoryBreakdown?: { name: string; expenseCents: number }[]
  monthlySeries?: { label: string; incomeCents: number; expenseCents: number; netCents: number }[]
  savingsRateHint?: string
}

export async function generateFinanceInsights(input: FinanceInsightsInput): Promise<string> {
  const lines: string[] = [
    'És um assistente de finanças pessoais. O utilizador fala português (Brasil).',
    'Responde em português do Brasil, de forma clara e prática.',
    'Não inventes números: só usa os dados fornecidos.',
    'Não dês aconselhamento jurídico nem de investimento específico (ações, cripto); mantém dicas gerais de hábitos, orçamento e atenção a riscos.',
    'Formata com subtítulos curtos em markdown (## e ###) e listas quando fizer sentido.',
    '',
    '## Dados do utilizador',
    `Modo: ${input.mode === 'overview' ? 'visão geral (todo o histórico agregado)' : `mês: ${input.monthLabel ?? ''}`}`,
    `Entradas (centavos): ${input.totals.incomeCents}`,
    `Saídas (centavos): ${input.totals.expenseCents}`,
    `Resultado líquido (centavos): ${input.totals.netCents}`,
  ]

  if (input.categoryBreakdown?.length) {
    lines.push('', '## Gastos por categoria (centavos)')
    for (const c of input.categoryBreakdown) {
      lines.push(`- ${c.name}: ${c.expenseCents}`)
    }
  }

  if (input.monthlySeries?.length) {
    lines.push('', '## Série mensal (rótulo; entradas; saídas; líquido; centavos)')
    for (const m of input.monthlySeries) {
      lines.push(`- ${m.label}: in ${m.incomeCents}, out ${m.expenseCents}, net ${m.netCents}`)
    }
  }

  if (input.savingsRateHint) {
    lines.push('', '## Nota', input.savingsRateHint)
  }

  lines.push(
    '',
    '## O que pedimos',
    '1) 3 a 6 pontos onde o utilizador deve ter MAIS ATENÇÃO (com base nos dados).',
    '2) 4 a 7 dicas acionáveis para melhorar (orçamento, categorização, reserva, hábitos).',
    '3) Um parágrafo curto de “resumo do mês” ou do período.',
  )

  return financeLlmGenerateText(lines.join('\n'))
}

export type UncategorizedTxPayload = {
  id: string
  date: string
  description: string
  amountCents: number
  kind: 'debit' | 'credit'
}

export type CategorySuggestionRow = {
  transactionId: string
  categoryName: string
  confidence: 'alta' | 'media' | 'baixa'
  reason: string
}

type CategorizeResponse = { suggestions: CategorySuggestionRow[] }

const BATCH_LIMIT = 35

export function sliceForCategorize(rows: UncategorizedTxPayload[]): UncategorizedTxPayload[] {
  return rows.slice(0, BATCH_LIMIT)
}

export async function suggestCategoriesForTransactions(
  categories: string[],
  transactions: UncategorizedTxPayload[],
): Promise<CategorySuggestionRow[]> {
  if (categories.length === 0) return []
  const batch = sliceForCategorize(transactions)
  if (batch.length === 0) return []

  const prompt = [
    'Recebes transações bancárias SEM categoria e uma lista FECHADA de nomes de categorias.',
    'Para cada transação, escolhe EXATAMENTE um nome da lista (correspondência exata de texto) ou, se nenhuma encaixar bem, usa o nome mais próximo ainda presente na lista.',
    'Se a lista estiver vazia, devolve suggestions: [].',
    'Responde APENAS com JSON válido no formato:',
    '{"suggestions":[{"transactionId":"uuid","categoryName":"Nome da lista","confidence":"alta|media|baixa","reason":"curto"}]}',
    '',
    'Categorias permitidas (usa só estes nomes no campo categoryName):',
    JSON.stringify(categories),
    '',
    'Transações (id, data YYYY-MM-DD, descrição, valor em centavos positivos, tipo debit|credit):',
    JSON.stringify(
      batch.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amountCents: t.amountCents,
        kind: t.kind,
      })),
    ),
  ].join('\n')

  const parsed = await financeLlmGenerateJson<CategorizeResponse>(prompt)
  if (!parsed?.suggestions || !Array.isArray(parsed.suggestions)) return []

  const allowed = new Set(categories.map((c) => c.trim().toLowerCase()))
  const norm = (s: string) => s.trim().toLowerCase()

  return parsed.suggestions.filter((s) => {
    if (!s?.transactionId || !s.categoryName) return false
    return allowed.has(norm(s.categoryName))
  })
}
