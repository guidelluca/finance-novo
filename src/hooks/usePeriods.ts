import { format } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { fetchSalaryAnchors, makePeriods, readMonthMode, type Periods } from '@/lib/period'

// uma busca por sessão; recarrega quando um salário novo é importado (evento abaixo)
let cached: { userId: string; anchors: string[] } | null = null
let inflight: Promise<string[]> | null = null
const listeners = new Set<(a: string[]) => void>()

export function refreshSalaryAnchors(userId: string) {
  inflight = fetchSalaryAnchors(userId).then((a) => {
    cached = { userId, anchors: a }
    inflight = null
    for (const l of listeners) l(a)
    return a
  })
  return inflight
}

/** Mês financeiro do usuário (começa no salário do fim do mês, ou no dia 1 se ele preferir). */
export function usePeriods(): Periods & { ready: boolean; current: string; today: string } {
  const { user } = useAuth()
  const [anchors, setAnchors] = useState<string[] | null>(() => (cached && cached.userId === user?.id ? cached.anchors : null))

  useEffect(() => {
    if (!user) return
    const l = (a: string[]) => setAnchors(a)
    listeners.add(l)
    if (cached?.userId === user.id) setAnchors(cached.anchors)
    else void (inflight ?? refreshSalaryAnchors(user.id))
    return () => {
      listeners.delete(l)
    }
  }, [user])

  const mode = readMonthMode(user)
  const p = useMemo(() => makePeriods(mode, anchors ?? []), [mode, anchors])
  const today = format(new Date(), 'yyyy-MM-dd')
  return { ...p, ready: mode === 'calendario' || anchors !== null, current: p.periodOf(today), today }
}
