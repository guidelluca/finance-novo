import type { User } from '@supabase/supabase-js'
import { format } from 'date-fns'
import { loadMerchantMemory, suggestCategory } from '@/lib/categorize'
import { transactionDedupCandidates } from '@/lib/dedupKey'
import { PENDING_TAG } from '@/lib/openFinance'
import { supabase } from '@/lib/supabase'
import type { TransactionDraft } from '@/parsers/types'
import type { Category, Rule } from '@/types/database'

const OF_PARSER = 'open_finance_pluggy_v1'

/**
 * Salva sozinho os lançamentos novos do Open Finance (os que ainda não estão no app).
 * Categoria escolhida pelas suas regras, lojas conhecidas, categoria do banco e o que você já usou.
 */
export async function autoSaveDrafts(user: User, drafts: TransactionDraft[]): Promise<number> {
  const toSave = drafts.filter((d) => !d.excluded)
  if (!toSave.length) return 0

  const [{ data: rules }, { data: cats }, memory] = await Promise.all([
    supabase.from('rules').select('*').eq('user_id', user.id).eq('enabled', true),
    supabase.from('categories').select('*').eq('user_id', user.id),
    loadMerchantMemory(user.id).catch(() => undefined),
  ])
  const ctx = { rules: (rules ?? []) as Rule[], categories: (cats ?? []) as Category[], memory }

  const { data: batch, error: bErr } = await supabase
    .from('import_batches')
    .insert({ user_id: user.id, parser_id: OF_PARSER, parser_version: 'v1', status: 'completed' })
    .select('id')
    .single()
  if (bErr || !batch) throw bErr ?? new Error('Não consegui criar a importação.')
  const { data: file, error: fErr } = await supabase
    .from('import_files')
    .insert({ batch_id: batch.id, filename: `open-finance-automatico-${format(new Date(), 'yyyyMMdd-HHmm')}`, parser_id: OF_PARSER })
    .select('id')
    .single()
  if (fErr || !file) throw fErr ?? new Error('Não consegui criar a importação.')

  const occ = new Map<string, number>()
  const rows = await Promise.all(
    toSave.map(async (d) => {
      const base = `${d.date}|${d.amountCents}|${d.kind}|${d.descriptionRaw.trim().toLowerCase()}`
      const n = (occ.get(base) ?? 0) + 1
      occ.set(base, n)
      const descKey = n === 1 ? d.descriptionRaw : `${d.descriptionRaw} #${n}`
      const account = d.accountHint?.trim() || 'Open Finance'
      const keys = await transactionDedupCandidates(user.id, d.date, d.amountCents, d.kind, descKey, d.sourceId, account, OF_PARSER)
      const cat = suggestCategory({ description: d.descriptionRaw, account, ofCategory: d.ofCategory ?? null }, ctx).categoryId
      return {
        keys,
        row: {
          user_id: user.id,
          date: d.date,
          amount_cents: d.amountCents,
          description_raw: d.descriptionRaw,
          description_normalized: descKey.toLowerCase(),
          kind: d.kind,
          account,
          dedup_key: keys[0]!,
          category_id: cat ?? null,
          import_batch_id: batch.id,
          import_file_id: file.id,
          credit_card_id: null,
        },
      }
    }),
  )

  // o que já foi salvo antes com a mesma chave fica de fora
  const existing = new Set<string>()
  const allKeys = [...new Set(rows.flatMap((r) => r.keys))]
  for (let i = 0; i < allKeys.length; i += 80) {
    const { data } = await supabase.from('transactions').select('dedup_key').eq('user_id', user.id).in('dedup_key', allKeys.slice(i, i + 80))
    for (const r of data ?? []) if (r.dedup_key) existing.add(r.dedup_key)
  }
  const fresh = rows.filter((r) => !r.keys.some((k) => existing.has(k))).map((r) => r.row)

  let saved = 0
  for (let i = 0; i < fresh.length; i += 50) {
    const chunk = fresh.slice(i, i + 50)
    const { error } = await supabase.from('transactions').insert(chunk)
    if (!error) {
      saved += chunk.length
      continue
    }
    // um repetido derruba o lote inteiro: tenta um por um
    for (const row of chunk) {
      const { error: e1 } = await supabase.from('transactions').insert(row)
      if (!e1) saved += 1
    }
  }
  if (!saved) await supabase.from('import_batches').delete().eq('id', batch.id)
  return saved
}

/**
 * Pendentes já salvos:
 *  - o banco confirmou (veio a versão oficial) → tira o "pendente" e acerta data/valor/descrição;
 *  - continua pendente → fica;
 *  - sumiu do banco (compra cancelada ou trocada pela oficial com outro valor) → apaga.
 */
export async function settlePending(
  user: User,
  from: string,
  drafts: TransactionDraft[],
  matches: { tempId: string; rowId: string }[],
): Promise<{ confirmed: number; removed: number }> {
  const { data } = await supabase
    .from('transactions')
    .select('id, date, description_raw')
    .eq('user_id', user.id)
    .gte('date', from)
    .like('description_raw', `%${PENDING_TAG}`)
  const pending = data ?? []
  if (!pending.length) return { confirmed: 0, removed: 0 }
  const draftByTemp = new Map(drafts.map((d) => [d.tempId, d]))
  const matchOf = new Map(matches.map((m) => [m.rowId, draftByTemp.get(m.tempId)]))
  let confirmed = 0
  let removed = 0
  for (const row of pending) {
    const d = matchOf.get(row.id)
    if (!d) {
      const { error } = await supabase.from('transactions').delete().eq('id', row.id)
      if (!error) removed += 1
      continue
    }
    if (d.ofPending) continue
    const { error } = await supabase
      .from('transactions')
      .update({ description_raw: d.descriptionRaw, date: d.date, amount_cents: d.amountCents })
      .eq('id', row.id)
    if (!error) confirmed += 1
  }
  return { confirmed, removed }
}
