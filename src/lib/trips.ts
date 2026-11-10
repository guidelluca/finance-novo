/**
 * Viagens com controle de gastos.
 *   planejado  = itens que você lança (passagem 12x, hospedagem, seguro…)
 *   real       = lançamentos do extrato/fatura ligados à viagem:
 *                pago (já saiu) + a pagar (parcelas futuras, inclusive as ainda não importadas)
 *   previsão   = por categoria, o maior entre planejado e real (+ o real sem plano)
 */
import { financeLlmGenerateJson, isFinanceLlmConfigured } from '@/lib/financeLlm'
import { planGoal, type LinkedTx } from '@/lib/goalPlan'
import { supabase } from '@/lib/supabase'

export type Trip = {
  id: string
  name: string
  destination: string | null
  start_date: string | null
  end_date: string | null
  budget_cents: number | null
  keywords: string[]
  notes: string | null
  archived: boolean
  created_at: string
}
export type TripItem = {
  id: string
  trip_id: string
  category: string
  description: string
  amount_cents: number
  installments: number
  first_date: string | null
}
export type TripLink = { trip_id: string; transaction_id: string; item_id: string | null }
export type TxLite = { id: string; date: string; amount_cents: number; description_raw: string; kind: 'debit' | 'credit'; account: string | null }

export const TRIP_CATEGORIES = [
  { key: 'passagem', label: 'Passagem' },
  { key: 'hospedagem', label: 'Hospedagem' },
  { key: 'alimentacao', label: 'Alimentação' },
  { key: 'transporte', label: 'Transporte local' },
  { key: 'passeios', label: 'Passeios e ingressos' },
  { key: 'seguro', label: 'Seguro e documentos' },
  { key: 'estudos', label: 'Curso / escola' },
  { key: 'compras', label: 'Compras' },
  { key: 'outros', label: 'Outros' },
] as const
export type TripCategory = (typeof TRIP_CATEGORIES)[number]['key']
export const catLabel = (k: string) => TRIP_CATEGORIES.find((c) => c.key === k)?.label ?? 'Outros'

/** Categoria da viagem pelo texto do lançamento. */
export function guessTripCategory(desc: string): TripCategory {
  const d = desc.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  if (/latam|\bgol\b|voegol|azul linhas|\btap\b|iberia|air ?france|klm|lufthansa|ryanair|easyjet|vueling|ita airways|passage|aerea|airlines|decolar|123milhas|maxmilhas|smiles|milhas/.test(d)) return 'passagem'
  if (/booking|airbnb|hotel|hostel|pousada|hospedag|residencia|aluguel temporada|resort/.test(d)) return 'hospedagem'
  if (/seguro viagem|assist card|affinity|passaporte|visto|consulado|apostila|traduc|policia federal|gru\b/.test(d)) return 'seguro'
  if (/escola|curso|matricula|universidad|college|idiomas|intercambio|cambridge|ielts|toefl/.test(d)) return 'estudos'
  if (/uber|\b99\b|cabify|bolt|metro|renfe|trem|onibus|rodoviaria|flixbus|blablacar|aluguel de carro|localiza|movida|unidas|combustivel|posto/.test(d)) return 'transporte'
  if (/ingresso|ticket|tour|museu|passeio|parque|show|sympla|eventim|ticketmaster|sagrada|park guell|excurs/.test(d)) return 'passeios'
  if (/restaur|bar\b|cafe|lanch|ifood|padaria|mercado|supermerc|pizza|burger|sushi|churrasc/.test(d)) return 'alimentacao'
  if (/loja|shop|store|zara|decathlon|primark|amazon|mercado livre|shopee/.test(d)) return 'compras'
  return 'outros'
}

export const isMissingTable = (e: { code?: string; message?: string } | null) =>
  Boolean(e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .*trips|could not find the table/i.test(e.message ?? '')))

export async function loadTrips(userId: string) {
  const [t, i, l] = await Promise.all([
    supabase.from('trips').select('*').eq('user_id', userId).order('start_date', { ascending: true, nullsFirst: false }),
    supabase.from('trip_items').select('*').eq('user_id', userId),
    supabase.from('trip_transactions').select('trip_id, transaction_id, item_id').eq('user_id', userId),
  ])
  const err = t.error ?? i.error ?? l.error
  if (err) return { trips: [] as Trip[], items: [] as TripItem[], links: [] as TripLink[], txs: [] as TxLite[], error: err }
  const links = (l.data ?? []) as TripLink[]
  const ids = [...new Set(links.map((x) => x.transaction_id))]
  const txs: TxLite[] = []
  for (let k = 0; k < ids.length; k += 150) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, date, amount_cents, description_raw, kind, account')
      .in('id', ids.slice(k, k + 150))
    if (error) return { trips: [] as Trip[], items: [] as TripItem[], links, txs, error }
    txs.push(...((data ?? []) as TxLite[]))
  }
  return { trips: (t.data ?? []) as Trip[], items: (i.data ?? []) as TripItem[], links, txs, error: null }
}

/** Lançamentos que parecem desta viagem (palavras-chave), ou busca livre; sem os já ligados. */
export async function searchTxs(userId: string, terms: string[], linkedIds: Set<string>, since: string): Promise<TxLite[]> {
  const kws = terms.map((k) => k.trim().replace(/[%,()]/g, ' ').trim()).filter((k) => k.length >= 2)
  if (!kws.length) return []
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount_cents, description_raw, kind, account')
    .eq('user_id', userId)
    .gte('date', since)
    .or(kws.map((k) => `description_raw.ilike.%${k}%`).join(','))
    .order('date', { ascending: false })
    .limit(80)
  if (error) throw error
  return ((data ?? []) as TxLite[]).filter((t) => !linkedIds.has(t.id))
}

const toLinked = (t: TxLite): LinkedTx => ({ id: t.id, date: t.date, amountCents: t.amount_cents, description: t.description_raw, kind: t.kind })

export type CatRow = { key: string; label: string; plannedCents: number; realCents: number; forecastCents: number }
export type ItemStatus = { item: TripItem; realCents: number; matchedCount: number; status: 'ok' | 'parcial' | 'acima' | 'sem_lancamento' }
export type TripSummary = {
  plannedCents: number
  paidCents: number
  committedCents: number
  realCents: number
  forecastCents: number
  byCategory: CatRow[]
  items: ItemStatus[]
  installments: ReturnType<typeof planGoal>['installments']
  nextMonthCents: number
  days: number | null
}

/** Pago + a pagar de um conjunto de lançamentos (deduz parcelas não importadas). */
function realOf(txs: TxLite[], today: string) {
  const p = planGoal({ targetCents: null, savedCents: 0, savedThisMonthCents: 0, createdAt: today, deadline: null, today, linked: txs.map(toLinked) })
  return p
}

export function summarizeTrip(trip: Trip, items: TripItem[], links: TripLink[], txs: TxLite[], today: string): TripSummary {
  const myLinks = links.filter((l) => l.trip_id === trip.id)
  const byId = new Map(txs.map((t) => [t.id, t]))
  const myTxs = myLinks.map((l) => byId.get(l.transaction_id)).filter((t): t is TxLite => Boolean(t))
  const myItems = items.filter((i) => i.trip_id === trip.id)
  const all = realOf(myTxs, today)

  // real por categoria: item ligado manda; senão, adivinha pelo texto
  const itemCat = new Map(myItems.map((i) => [i.id, i.category]))
  const catOfTx = (t: TxLite) => {
    const l = myLinks.find((x) => x.transaction_id === t.id)
    return (l?.item_id && itemCat.get(l.item_id)) || guessTripCategory(t.description_raw)
  }
  const byCat = new Map<string, TxLite[]>()
  for (const t of myTxs) byCat.set(catOfTx(t), [...(byCat.get(catOfTx(t)) ?? []), t])

  const rows: CatRow[] = TRIP_CATEGORIES.map((c) => {
    const planned = myItems.filter((i) => i.category === c.key).reduce((a, i) => a + i.amount_cents, 0)
    const r = realOf(byCat.get(c.key) ?? [], today)
    const real = r.paidCents + r.committedCents
    return { key: c.key, label: c.label, plannedCents: planned, realCents: real, forecastCents: Math.max(planned, real) }
  }).filter((r) => r.plannedCents || r.realCents)

  const itemStatus: ItemStatus[] = myItems.map((item) => {
    const linked = myLinks.filter((l) => l.item_id === item.id).map((l) => byId.get(l.transaction_id)).filter((t): t is TxLite => Boolean(t))
    const r = realOf(linked, today)
    const real = r.paidCents + r.committedCents
    const status: ItemStatus['status'] = !linked.length
      ? 'sem_lancamento'
      : Math.abs(real - item.amount_cents) <= Math.max(100, item.amount_cents * 0.02)
        ? 'ok'
        : real > item.amount_cents
          ? 'acima'
          : 'parcial'
    return { item, realCents: real, matchedCount: linked.length, status }
  })

  const days =
    trip.start_date && trip.end_date
      ? Math.max(1, Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 86_400_000) + 1)
      : null
  return {
    plannedCents: myItems.reduce((a, i) => a + i.amount_cents, 0),
    paidCents: all.paidCents,
    committedCents: all.committedCents,
    realCents: all.paidCents + all.committedCents,
    forecastCents: rows.reduce((a, r) => a + r.forecastCents, 0),
    byCategory: rows,
    items: itemStatus,
    installments: all.installments,
    nextMonthCents: all.nextMonthInstallmentsCents,
    days,
  }
}

/** Lançamentos parecidos com um item planejado (valor da parcela ou total, texto parecido). */
export function matchItemCandidates(item: TripItem, pool: TxLite[]): TxLite[] {
  const per = Math.round(item.amount_cents / Math.max(1, item.installments))
  const words = item.description
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  return pool.filter((t) => {
    if (t.kind !== 'debit') return false
    const closeValue = Math.abs(t.amount_cents - per) <= Math.max(200, per * 0.03) || Math.abs(t.amount_cents - item.amount_cents) <= Math.max(200, item.amount_cents * 0.03)
    const d = t.description_raw.toLowerCase()
    const sameWords = words.some((w) => d.includes(w))
    return closeValue || sameWords
  })
}

export const aiAvailable = () => isFinanceLlmConfigured()

export type TripAi = {
  previsao_total_reais: number
  por_categoria: { categoria: string; estimativa_reais: number; comentario: string }[]
  sugestoes: string[]
  alertas: string[]
}

/** Previsão e sugestões com IA (só números agregados da viagem; nada de nomes ou contas). */
export async function askTripAi(trip: Trip, s: TripSummary): Promise<TripAi> {
  const brl = (c: number) => Math.round(c / 100)
  const prompt = `Você é um planejador financeiro de viagens para um brasileiro (gastos em reais).
Viagem: "${trip.name}"${trip.destination ? `, destino ${trip.destination}` : ''}${trip.start_date ? `, de ${trip.start_date}` : ''}${trip.end_date ? ` a ${trip.end_date}` : ''}${s.days ? ` (${s.days} dias)` : ''}.
Orçamento: ${trip.budget_cents ? `R$ ${brl(trip.budget_cents)}` : 'não definido'}.
Por categoria (planejado / já gasto ou parcelado), em R$:
${s.byCategory.map((r) => `- ${r.label}: ${brl(r.plannedCents)} / ${brl(r.realCents)}`).join('\n') || '- nada lançado ainda'}
Parcelas em andamento: ${s.installments.map((i) => `${i.name} ${i.paid}/${i.total} de R$ ${brl(i.perMonthCents)}`).join('; ') || 'nenhuma'}.
${trip.notes ? `Observações do viajante: ${trip.notes}` : ''}
Estime o custo total realista desta viagem (inclua categorias que faltam no planejamento, como alimentação diária, transporte local, seguro, chip/celular, imprevistos ~10%), use preços típicos atuais do destino convertidos para reais, e dê sugestões práticas para gastar menos e alertas de riscos (câmbio, IOF de cartão internacional, parcelas que se acumulam).
Responda APENAS JSON: {"previsao_total_reais": number, "por_categoria": [{"categoria": string, "estimativa_reais": number, "comentario": string}], "sugestoes": [string, até 5], "alertas": [string, até 3]}. Português do Brasil.`
  return financeLlmGenerateJson<TripAi>(prompt)
}
