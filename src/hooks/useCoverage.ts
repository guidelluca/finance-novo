import { format } from 'date-fns'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePeriods } from '@/hooks/usePeriods'
import {
  computeCoverage,
  fetchCoverageTxs,
  readAccounts,
  readCoverageMarks,
  type AccountCoverage,
  type CoverageTx,
} from '@/lib/accounts'
import { computeQuietDays, readQuietMarks } from '@/lib/quietDays'

/** Cobertura dos extratos de cada conta acompanhada no mês. */
export function useCoverage(month: string) {
  const { user } = useAuth()
  const periods = usePeriods()
  const bounds = useMemo(() => periods.rangeOf(month), [periods, month])
  const [txs, setTxs] = useState<CoverageTx[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      setTxs(await fetchCoverageTxs(user.id, month))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [user, month])

  useEffect(() => {
    void load()
  }, [load])

  const accounts = useMemo(() => readAccounts(user), [user])
  const coverage: AccountCoverage[] = useMemo(
    () => computeCoverage(month, accounts, txs, format(new Date(), 'yyyy-MM-dd'), readCoverageMarks(user), bounds),
    [month, accounts, txs, user, bounds],
  )
  const quiet = useMemo(
    () => computeQuietDays(bounds, format(new Date(), 'yyyy-MM-dd'), txs, accounts, readQuietMarks(user)),
    [bounds, txs, accounts, user],
  )
  const done = coverage.filter((c) => c.status === 'completo' || c.status === 'em_andamento').length
  return { loading, error, coverage, accounts, quiet, done, total: coverage.length, reload: load, bounds }
}
