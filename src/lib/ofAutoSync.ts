import type { User } from '@supabase/supabase-js'
import { mergeOpenFinanceDrafts } from '@/lib/mergeMatch'
import { addOfCoverage, fetchOpenFinanceDrafts, lastSync, ofCards, ofOverview, pluggyTag, readConnections } from '@/lib/openFinance'
import { supabase } from '@/lib/supabase'

/**
 * Sincronização automática (uma vez por dia, ao abrir o app):
 *  - busca os lançamentos novos nos bancos e conta quantos ainda não estão no app (não salva sozinho: você revisa);
 *  - corrige lançamentos já salvos que a Pluggy sabe que são transferência entre contas suas / pagamento de fatura / aplicação;
 *  - atualiza saldos, investimentos, empréstimos e cartões (para patrimônio, alertas e conferência de saldo).
 */
export type AutoSyncState = {
  at: string
  fresh: number
  from: string
  to: string
  tagged: number
  error: string | null
}

export const OF_SYNC_EVENT = 'finance:of-synced'
const KEY = 'finance:of-auto'
const EVERY_MS = 20 * 3_600_000
const running = { on: false }

export function readAutoSync(): AutoSyncState | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as AutoSyncState) : null
  } catch {
    return null
  }
}

function write(s: AutoSyncState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* sem armazenamento */
  }
  window.dispatchEvent(new CustomEvent(OF_SYNC_EVENT))
}

const iso = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10)

export async function autoSync(user: User, opts: { force?: boolean } = {}): Promise<AutoSyncState | null> {
  const conns = readConnections(user)
  if (!conns.length || running.on) return readAutoSync()
  const prev = readAutoSync()
  if (!opts.force && prev && Date.now() - Date.parse(prev.at) < EVERY_MS) return prev
  running.on = true
  const to = iso(Date.now())
  const last = lastSync(user)
  // sempre olha pelo menos 45 dias (o que já está no app não conta como novo)
  const from = iso(Math.min(Date.now() - 45 * 86_400_000, last ? Date.parse(last) - 10 * 86_400_000 : Infinity))
  const state: AutoSyncState = { at: new Date().toISOString(), fresh: 0, from, to, tagged: 0, error: null }
  try {
    // saldos/cartões primeiro (são rápidos e não dependem do resto)
    await Promise.allSettled([ofOverview(conns), ofCards(conns)])
    const r = await fetchOpenFinanceDrafts(conns, from, to, { markSynced: false })
    const m = await mergeOpenFinanceDrafts(user.id, r.drafts)
    state.fresh = m.drafts.filter((d) => !d.excluded).length
    // conta que veio inteira do Open Finance e já está toda no app: o mês fica conferido sozinho
    const pendingBy = new Set(m.drafts.filter((d) => !d.excluded).map((d) => d.accountHint ?? ''))
    await addOfCoverage(user, r.accounts.filter((a) => !pendingBy.has(a.label)).map((a) => a.label), from, to)
    // marca nos lançamentos já salvos o que a Pluggy identificou (sem mexer no resto)
    const byTemp = new Map(r.drafts.map((d) => [d.tempId, d]))
    for (const x of m.matches) {
      const d = byTemp.get(x.tempId)
      if (!d?.ofCategory) continue
      const isCard = Boolean(d.cardLast4) || /^cart[aã]o\b/i.test(d.accountHint ?? '')
      const tag = pluggyTag(d.ofCategory, x.rowDesc, isCard)
      if (!tag) continue
      const { error } = await supabase.from('transactions').update({ description_raw: `${x.rowDesc}${tag}` }).eq('id', x.rowId)
      if (!error) state.tagged += 1
    }
  } catch (e) {
    state.error = (e as Error).message
  } finally {
    running.on = false
  }
  write(state)
  return state
}

/** Você abriu a revisão dos lançamentos novos: o aviso some até a próxima sincronização. */
export function clearPending() {
  const s = readAutoSync()
  if (s && s.fresh) write({ ...s, fresh: 0 })
}
