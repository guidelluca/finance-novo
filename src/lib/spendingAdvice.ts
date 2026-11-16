import { financeLlmGenerateJson, isFinanceLlmConfigured } from '@/lib/financeLlm'

const BR = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })

export type AdviceInput = {
  /** 'credito': só o cartão (não calcula o quanto pode gastar no mês inteiro) */
  scope?: 'geral' | 'credito'
  month: string
  incomeCents: number
  spentCents: number
  daysLeft: number
  /** categorias do mês com a média dos 3 meses anteriores */
  categories: { name: string; cents: number; avgCents: number }[]
  credit?: { spentCents: number; pct: number | null; safeCents: number | null; nextMonthInstallmentsCents: number; limitUsePct: number | null }
  subscriptions?: { name: string; cents: number; increasePct: number | null }[]
  goals?: { name: string; monthlyNeededCents: number }[]
}

export type Advice = { kind: 'pode' | 'evitar' | 'dica'; title: string; detail: string }

/** Conselhos que não dependem de IA: contas com os seus números e as referências de sempre. */
export function ruleAdvice(a: AdviceInput): Advice[] {
  const out: Advice[] = []
  const free = a.incomeCents - a.spentCents
  if (a.scope !== 'credito' && a.incomeCents && a.daysLeft > 0) {
    const reserve = Math.round(a.incomeCents * 0.2) // 20% para guardar/investir
    const room = Math.max(0, free - reserve)
    out.push(
      room > 0
        ? { kind: 'pode', title: `Pode gastar até ${BR(room)} até o fim do mês`, detail: `${BR(Math.floor(room / a.daysLeft))} por dia, guardando 20% da renda (${BR(reserve)}).` }
        : { kind: 'evitar', title: 'O mês já passou do ponto de guardar 20%', detail: `Sobram ${BR(Math.max(0, free))} da renda. Segure gastos que não são essenciais até o próximo salário.` },
    )
  }
  if (a.credit?.pct != null && a.credit.safeCents != null) {
    if (a.credit.pct > 0.3)
      out.push({ kind: 'evitar', title: `Crédito em ${Math.round(a.credit.pct * 100)}% da renda`, detail: `Passou ${BR(a.credit.spentCents - a.credit.safeCents)} do teto de 30%. Use débito ou Pix até o fim do mês.` })
    else out.push({ kind: 'pode', title: `Ainda cabem ${BR(a.credit.safeCents - a.credit.spentCents)} no crédito`, detail: 'Sem passar de 30% da renda nas faturas.' })
  }
  if (a.credit && a.incomeCents && a.credit.nextMonthInstallmentsCents / a.incomeCents > 0.1)
    out.push({
      kind: 'evitar',
      title: 'Evite novos parcelamentos',
      detail: `${BR(a.credit.nextMonthInstallmentsCents)} do próximo mês já estão comprometidos com parcelas (${Math.round((a.credit.nextMonthInstallmentsCents / a.incomeCents) * 100)}% da renda).`,
    })
  if (a.credit?.limitUsePct != null && a.credit.limitUsePct > 0.3)
    out.push({ kind: 'dica', title: `Limite ${Math.round(a.credit.limitUsePct * 100)}% usado`, detail: 'Acima de 30% do limite (somando parcelas futuras) o aperto aparece rápido se surgir um imprevisto.' })
  for (const c of a.categories) {
    if (c.avgCents >= 5000 && c.cents > c.avgCents * 1.25 && c.cents - c.avgCents >= 10000)
      out.push({ kind: 'evitar', title: `${c.name} acima do normal`, detail: `${BR(c.cents)} este mês contra média de ${BR(c.avgCents)} (+${Math.round((c.cents / c.avgCents - 1) * 100)}%).` })
  }
  const subs = a.subscriptions ?? []
  const up = subs.filter((s) => s.increasePct)
  if (up.length) out.push({ kind: 'dica', title: 'Assinaturas subiram de preço', detail: up.map((s) => `${s.name} +${Math.round((s.increasePct ?? 0) * 100)}%`).join(', ') })
  const subTotal = subs.reduce((s, x) => s + x.cents, 0)
  if (a.incomeCents && subTotal / a.incomeCents > 0.05)
    out.push({ kind: 'dica', title: `Assinaturas: ${BR(subTotal)}/mês`, detail: 'Mais de 5% da renda. Revise o que você não usou nas últimas semanas.' })
  out.push({ kind: 'dica', title: 'Pague sempre a fatura inteira', detail: 'Pagar só o mínimo joga o resto no rotativo, que passa de 400% ao ano. Se apertar, parcelar a fatura sai mais barato.' })
  return out
}

export type AiAdvice = { pode_gastar: { item: string; valor_reais: number | null; motivo: string }[]; evitar: { item: string; economia_reais: number | null; motivo: string }[]; dicas: string[] }

const CACHE = 'finance:ai-advice'

export function readAiAdvice(key: string): { at: string; data: AiAdvice } | null {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Record<string, { at: string; data: AiAdvice }>
    return all[key] ?? null
  } catch {
    return null
  }
}

export const aiReady = () => isFinanceLlmConfigured()

export async function askAiAdvice(key: string, a: AdviceInput): Promise<AiAdvice> {
  const r = (c: number) => Math.round(c / 100)
  const prompt = `Você é um planejador financeiro pessoal brasileiro, direto e prático. Dê conselhos para o mês ${a.month}.
Renda líquida do mês: R$ ${r(a.incomeCents)}. ${a.scope === 'credito' ? 'Gasto no cartão até agora' : 'Gasto total até agora'}: R$ ${r(a.spentCents)}. Dias até o fim do mês: ${a.daysLeft}.
Gastos por categoria este mês (R$ agora / média dos 3 meses anteriores):
${a.categories.map((c) => `- ${c.name}: ${r(c.cents)} / ${r(c.avgCents)}`).join('\n') || '- sem dados'}
${a.credit ? `Cartão de crédito: R$ ${r(a.credit.spentCents)} no mês${a.credit.pct != null ? ` (${Math.round(a.credit.pct * 100)}% da renda; referência saudável: até 30%)` : ''}; parcelas já comprometidas no próximo mês: R$ ${r(a.credit.nextMonthInstallmentsCents)}${a.credit.limitUsePct != null ? `; limite usado ${Math.round(a.credit.limitUsePct * 100)}%` : ''}.` : ''}
${a.subscriptions?.length ? `Assinaturas: ${a.subscriptions.map((s) => `${s.name} R$ ${r(s.cents)}${s.increasePct ? ` (subiu ${Math.round(s.increasePct * 100)}%)` : ''}`).join('; ')}.` : ''}
${a.goals?.length ? `Metas: ${a.goals.map((g) => `${g.name} precisa de R$ ${r(g.monthlyNeededCents)}/mês`).join('; ')}.` : ''}
Use SÓ esses números. Diga quanto ainda pode gastar e em quê (com valores), o que deveria cortar ou evitar (com economia estimada por mês) e até 4 dicas curtas. Leve em conta guardar pelo menos 20% da renda e não passar de 30% da renda no cartão.
Responda APENAS JSON: {"pode_gastar":[{"item":string,"valor_reais":number|null,"motivo":string}],"evitar":[{"item":string,"economia_reais":number|null,"motivo":string}],"dicas":[string]}. Português do Brasil, frases curtas.`
  const data = await financeLlmGenerateJson<AiAdvice>(prompt)
  try {
    const all = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Record<string, unknown>
    all[key] = { at: new Date().toISOString(), data }
    localStorage.setItem(CACHE, JSON.stringify(all))
  } catch {
    /* sem armazenamento */
  }
  return data
}
