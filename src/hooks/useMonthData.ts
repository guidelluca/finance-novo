import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { consolidateMonth, type ConsTx, type TxSource } from '@/lib/monthConsolidation'
import { supabase } from '@/lib/supabase'
import type { Category } from '@/types/database'

type Row = {
  id: string
  date: string
  amount_cents: number
  kind: 'debit' | 'credit'
  description_raw: string
  account: string | null
  category_id: string | null
  import_batch_id: string | null
  import_file_id: string | null
  credit_card_id: string | null
}

function sourceFromParser(parserId: string | undefined): TxSource {
  if (!parserId) return 'manual'
  if (parserId === 'fatura_cartao_pdf_v1') return 'fatura'
  if (parserId === 'screenshot_ai_v1' || parserId === 'screenshot_local_v1') return 'print'
  if (parserId.startsWith('csv_')) return 'csv'
  return 'extrato'
}

async function fetchRange(userId: string, from: string, to: string): Promise<Row[]> {
  const out: Row[] = []
  const page = 1000
  for (let i = 0; ; i += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, date, amount_cents, kind, description_raw, account, category_id, import_batch_id, import_file_id, credit_card_id')
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })
      .range(i, i + page - 1)
    if (error) throw error
    out.push(...((data ?? []) as Row[]))
    if (!data || data.length < page) break
  }
  return out
}

/** Lançamentos do mês + 6 meses de histórico, já consolidados (sem repetição). */
export function useMonthData(month: string) {
  const { user } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [parserByBatch, setParserByBatch] = useState<Map<string, string>>(new Map())
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const start = parseISO(`${month}-01`)
      const from = format(startOfMonth(subMonths(start, 6)), 'yyyy-MM-dd')
      const to = format(endOfMonth(start), 'yyyy-MM-dd')
      const [txs, batches, cats] = await Promise.all([
        fetchRange(user.id, from, to),
        supabase.from('import_batches').select('id, parser_id').eq('user_id', user.id),
        supabase.from('categories').select('*').eq('user_id', user.id).order('sort_order'),
      ])
      setRows(txs)
      setParserByBatch(new Map(((batches.data ?? []) as { id: string; parser_id: string }[]).map((b) => [b.id, b.parser_id])))
      setCategories((cats.data ?? []) as Category[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar.')
    } finally {
      setLoading(false)
    }
  }, [user, month])

  useEffect(() => {
    void load()
  }, [load])

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])

  const { monthTxs, history } = useMemo(() => {
    const all: ConsTx[] = rows.map((r) => ({
      id: r.id,
      date: r.date,
      amountCents: r.amount_cents,
      kind: r.kind,
      description: r.description_raw,
      account: r.account,
      categoryId: r.category_id,
      categoryName: r.category_id ? (catName.get(r.category_id) ?? null) : null,
      source: sourceFromParser(r.import_batch_id ? parserByBatch.get(r.import_batch_id) : undefined),
      importFileId: r.import_file_id,
      cardId: r.credit_card_id,
    }))
    return {
      monthTxs: all.filter((t) => t.date.startsWith(month)),
      history: all.filter((t) => t.date < `${month}-01`),
    }
  }, [rows, parserByBatch, catName, month])

  const result = useMemo(
    () => consolidateMonth(month, monthTxs, history, format(new Date(), 'yyyy-MM-dd')),
    [month, monthTxs, history],
  )

  return { loading, error, categories, result, monthTxs, history, reload: load }
}
