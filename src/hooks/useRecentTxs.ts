import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { OF_SYNC_EVENT } from '@/lib/ofAutoSync'
import type { RowTx } from '@/lib/ofInsights'
import { supabase } from '@/lib/supabase'

/** Lançamentos salvos dos últimos `days` dias (para alertas, assinaturas, parcelas e conferência de saldo). */
export function useRecentTxs(days = 200) {
  const { user } = useAuth()
  const [txs, setTxs] = useState<RowTx[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const on = () => setTick((x) => x + 1)
    window.addEventListener(OF_SYNC_EVENT, on)
    window.addEventListener('finance:recategorized', on)
    return () => {
      window.removeEventListener(OF_SYNC_EVENT, on)
      window.removeEventListener('finance:recategorized', on)
    }
  }, [])
  useEffect(() => {
    if (!user) return
    let alive = true
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    void (async () => {
      const out: RowTx[] = []
      for (let i = 0; i < 20000; i += 1000) {
        const { data, error } = await supabase
          .from('transactions')
          .select('id, date, amount_cents, kind, description_raw, account')
          .eq('user_id', user.id)
          .gte('date', since)
          .order('date')
          .range(i, i + 999)
        if (error || !data) break
        out.push(...(data as RowTx[]))
        if (data.length < 1000) break
      }
      if (alive) {
        setTxs(out)
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [user, days, tick])
  return { txs, loading }
}
