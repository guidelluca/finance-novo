/**
 * Mescla Open Finance × o que já estava no app (PDF, prints, manual).
 * Mesmo lançamento = mesmo tipo e valor exato, mesma instituição (Itaú com Itaú, cartão com cartão),
 * data até 3 dias de diferença (compra × lançamento) — e, se as datas não forem iguais, nome parecido.
 * Parcelas "n/N" iguais casam até 40 dias de diferença (cada banco data a parcela de um jeito).
 * Cada lançamento antigo casa com no máximo um novo (2 cafés iguais no extrato e 1 salvo → entra 1).
 */
import { supabase } from '@/lib/supabase'
import type { TransactionDraft } from '@/parsers/types'

export const OF_PARSER = 'open_finance_pluggy_v1'

export type ExistingRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'debit' | 'credit'
  description_raw: string
  account: string | null
  credit_card_id: string | null
  category_id: string | null
  import_batch_id: string | null
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function issuerOf(text: string | null | undefined): string | null {
  const t = fold(text ?? '')
  if (/itau|itaucard/.test(t)) return 'itau'
  if (/nubank|\bnu\b/.test(t)) return 'nubank'
  if (/picpay/.test(t)) return 'picpay'
  if (/\binter\b|bancointer/.test(t)) return 'inter'
  if (/mercado ?pago/.test(t)) return 'mercadopago'
  if (/alelo|\bvr\b/.test(t)) return 'alelo'
  return null
}
const isCardAccount = (acc: string | null | undefined, cardId?: string | null) => Boolean(cardId) || /cart[aã]o|cr[eé]dito/i.test(acc ?? '')

const STOP = new Set([
  'pix', 'transf', 'transferencia', 'enviado', 'enviada', 'recebido', 'recebida', 'compra', 'pagamento', 'pagto', 'pag', 'cartao', 'debito',
  'credito', 'ted', 'doc', 'para', 'pelo', 'com', 'ltda', 'sao', 'paulo', 'bra', 'apple', 'pay', 'parcela', 'via', 'qrs', 'qr', 'code', 'boleto',
])
function tokens(s: string): Set<string> {
  return new Set(
    fold(s)
      .replace(/\(parcela \d+\/\d+\)/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)),
  )
}
function similarity(a: string, b: string): number {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if ([...B].some((x) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))) inter += 1
  return inter / Math.min(A.size, B.size)
}
const parcela = (s: string) => {
  const m = s.match(/(?:parcela\s*)?(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\)?\s*$/i)
  return m && Number(m[2]) > 1 ? `${Number(m[1])}/${Number(m[2])}` : null
}
const days = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000))

export type Side = { key: string; date: string; cents: number; kind: string; desc: string; account: string | null; cardId?: string | null }

/** Pares (novo → antigo) com a melhor combinação, um para um. */
export function matchPairs(news: Side[], olds: Side[]): Map<string, { old: Side; sim: number; dd: number }> {
  const cands: { n: Side; o: Side; score: number; sim: number; dd: number }[] = []
  const byAmount = new Map<string, Side[]>()
  for (const o of olds) byAmount.set(`${o.kind}|${o.cents}`, [...(byAmount.get(`${o.kind}|${o.cents}`) ?? []), o])
  for (const n of news) {
    for (const o of byAmount.get(`${n.kind}|${n.cents}`) ?? []) {
      const ni = issuerOf(n.account)
      const oi = issuerOf(o.account)
      if (ni && oi && ni !== oi) continue
      const nc = isCardAccount(n.account, n.cardId)
      const oc = isCardAccount(o.account, o.cardId)
      if (n.account && o.account && nc !== oc) continue
      const dd = days(n.date, o.date)
      const pn = parcela(n.desc)
      const samePar = Boolean(pn && pn === parcela(o.desc))
      if (dd > (samePar ? 40 : 3)) continue
      const sim = similarity(n.desc, o.desc)
      // datas diferentes só casam com nome parecido (ou mesma parcela)
      if (dd > 0 && sim < 0.34 && !samePar) continue
      cands.push({ n, o, sim, dd, score: (samePar ? 3 : 0) + sim * 2 + (3 - Math.min(3, dd)) })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const usedN = new Set<string>()
  const usedO = new Set<string>()
  const out = new Map<string, { old: Side; sim: number; dd: number }>()
  for (const c of cands) {
    if (usedN.has(c.n.key) || usedO.has(c.o.key)) continue
    usedN.add(c.n.key)
    usedO.add(c.o.key)
    out.set(c.n.key, { old: c.o, sim: c.sim, dd: c.dd })
  }
  return out
}

async function ofBatchIds(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from('import_batches').select('id').eq('user_id', userId).eq('parser_id', OF_PARSER)
  return new Set(((data ?? []) as { id: string }[]).map((b) => b.id))
}

async function loadRange(userId: string, from: string, to: string): Promise<ExistingRow[]> {
  const out: ExistingRow[] = []
  for (let i = 0; i < 20000; i += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, date, amount_cents, kind, description_raw, account, credit_card_id, category_id, import_batch_id')
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('id')
      .range(i, i + 999)
    if (error) throw error
    out.push(...((data ?? []) as ExistingRow[]))
    if (!data || data.length < 1000) break
  }
  return out
}

const shift = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * Antes de revisar a busca do Open Finance: o que já está no app vem desmarcado, dizendo com qual
 * lançamento casou. Você pode marcar de volta se não for o mesmo.
 */
export async function mergeOpenFinanceDrafts(userId: string, drafts: TransactionDraft[]): Promise<{ drafts: TransactionDraft[]; already: number; merged: number }> {
  if (!drafts.length) return { drafts, already: 0, merged: 0 }
  const dates = drafts.map((d) => d.date).sort()
  const [rows, ofIds] = await Promise.all([loadRange(userId, shift(dates[0]!, -40), shift(dates[dates.length - 1]!, 40)), ofBatchIds(userId)])
  const news: Side[] = drafts.map((d) => ({ key: d.tempId, date: d.date, cents: d.amountCents, kind: d.kind, desc: d.descriptionRaw, account: d.accountHint ?? null, cardId: d.cardLast4 ? 'card' : null }))
  const olds: Side[] = rows.map((r) => ({ key: r.id, date: r.date, cents: r.amount_cents, kind: r.kind, desc: r.description_raw, account: r.account, cardId: r.credit_card_id }))
  const pairs = matchPairs(news, olds)
  const rowById = new Map(rows.map((r) => [r.id, r]))
  let already = 0
  let merged = 0
  const out = drafts.map((d) => {
    const p = pairs.get(d.tempId)
    if (!p) return d
    const row = rowById.get(p.old.key)!
    const fromOf = row.import_batch_id ? ofIds.has(row.import_batch_id) : false
    if (fromOf) already += 1
    else merged += 1
    return {
      ...d,
      excluded: true,
      reviewFlags: [
        ...(d.reviewFlags ?? []).filter((f) => !/possível repetida|já está salvo/.test(f)),
        fromOf
          ? 'já veio numa busca anterior do Open Finance'
          : `já está no app: “${row.description_raw.slice(0, 40)}” em ${br(row.date)} (${row.account ?? 'sem conta'}) — marque se for outro lançamento`,
      ],
    }
  })
  return { drafts: out, already, merged }
}

/* ----------------------------------------------------------------- limpeza do que já foi salvo */

export type DupPair = { of: ExistingRow; old: ExistingRow }

/** Lançamentos do Open Finance já salvos que repetem um lançamento antigo (PDF/print/manual). */
export async function findSavedDuplicates(userId: string): Promise<DupPair[]> {
  const ofIds = await ofBatchIds(userId)
  if (!ofIds.size) return []
  const ofRows: ExistingRow[] = []
  for (const id of ofIds) {
    const { data } = await supabase
      .from('transactions')
      .select('id, date, amount_cents, kind, description_raw, account, credit_card_id, category_id, import_batch_id')
      .eq('user_id', userId)
      .eq('import_batch_id', id)
    ofRows.push(...((data ?? []) as ExistingRow[]))
  }
  if (!ofRows.length) return []
  const dates = ofRows.map((r) => r.date).sort()
  const others = (await loadRange(userId, shift(dates[0]!, -40), shift(dates[dates.length - 1]!, 40))).filter((r) => !(r.import_batch_id && ofIds.has(r.import_batch_id)))
  const side = (r: ExistingRow): Side => ({ key: r.id, date: r.date, cents: r.amount_cents, kind: r.kind, desc: r.description_raw, account: r.account, cardId: r.credit_card_id })
  const pairs = matchPairs(ofRows.map(side), others.map(side))
  const byId = new Map([...ofRows, ...others].map((r) => [r.id, r]))
  return [...pairs.entries()].map(([ofId, p]) => ({ of: byId.get(ofId)!, old: byId.get(p.old.key)! }))
}

/** Junta cada par: fica o lançamento antigo (com suas edições); categoria e viagem do novo passam para ele. */
export async function mergeSavedDuplicates(userId: string, pairs: DupPair[]): Promise<number> {
  let n = 0
  for (const p of pairs) {
    if (!p.old.category_id && p.of.category_id) {
      await supabase.from('transactions').update({ category_id: p.of.category_id }).eq('user_id', userId).eq('id', p.old.id)
    }
    // viagem ligada ao novo passa para o antigo (se já não estiver ligada)
    const { data: links } = await supabase.from('trip_transactions').select('trip_id, item_id').eq('user_id', userId).eq('transaction_id', p.of.id)
    for (const l of (links ?? []) as { trip_id: string; item_id: string | null }[]) {
      await supabase.from('trip_transactions').upsert({ trip_id: l.trip_id, transaction_id: p.old.id, user_id: userId, item_id: l.item_id })
    }
    const { error } = await supabase.from('transactions').delete().eq('user_id', userId).eq('id', p.of.id)
    if (!error) n += 1
  }
  return n
}

/** Importação de arquivo/print: o que já veio pelo Open Finance vem desmarcado. */
export async function mergeAgainstOpenFinance(userId: string, drafts: TransactionDraft[]): Promise<TransactionDraft[]> {
  if (!drafts.length) return drafts
  const ofIds = await ofBatchIds(userId)
  if (!ofIds.size) return drafts
  const dates = drafts.map((d) => d.date).sort()
  const rows = (await loadRange(userId, shift(dates[0]!, -40), shift(dates[dates.length - 1]!, 40))).filter((r) => r.import_batch_id && ofIds.has(r.import_batch_id))
  if (!rows.length) return drafts
  const news: Side[] = drafts.filter((d) => !d.excluded).map((d) => ({ key: d.tempId, date: d.date, cents: d.amountCents, kind: d.kind, desc: d.descriptionRaw, account: d.accountHint ?? null, cardId: d.cardLast4 ? 'card' : null }))
  const olds: Side[] = rows.map((r) => ({ key: r.id, date: r.date, cents: r.amount_cents, kind: r.kind, desc: r.description_raw, account: r.account, cardId: r.credit_card_id }))
  const pairs = matchPairs(news, olds)
  const rowById = new Map(rows.map((r) => [r.id, r]))
  return drafts.map((d) => {
    const p = pairs.get(d.tempId)
    if (!p) return d
    const row = rowById.get(p.old.key)!
    return {
      ...d,
      excluded: true,
      reviewFlags: [
        ...(d.reviewFlags ?? []).filter((f) => !/possível repetida/.test(f)),
        `já veio pelo Open Finance: “${row.description_raw.slice(0, 40)}” em ${br(row.date)} — marque se for outro lançamento`,
      ],
    }
  })
}
