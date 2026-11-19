import { AlertTriangle, Bell, ChevronRight, Landmark, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useRecentTxs } from '@/hooks/useRecentTxs'
import { OF_SYNC_EVENT, readAutoSync } from '@/lib/ofAutoSync'
import { buildAlerts, checkBalances } from '@/lib/ofInsights'
import { readBalanceSnapshots, readCardsCache, readConnections, readOverviewCache } from '@/lib/openFinance'
import { rentMissingNow } from '@/lib/rentStatus'
import { cn } from '@/lib/utils'

const DISMISS = 'finance:alerts-dismissed'
function readDismissed(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Alertas na Home + aviso de lançamentos novos vindos dos bancos. */
export function OfAlerts({ today, pace }: { today: string; pace: { deltaPct: number; spentCents: number; prevCents: number } | null }) {
  const { user } = useAuth()
  const { txs } = useRecentTxs(200)
  const [tick, setTick] = useState(0)
  const [dismissed, setDismissed] = useState(readDismissed)
  useEffect(() => {
    const on = () => setTick((x) => x + 1)
    window.addEventListener(OF_SYNC_EVENT, on)
    return () => window.removeEventListener(OF_SYNC_EVENT, on)
  }, [])
  const hasOf = readConnections(user).length > 0
  const sync = useMemo(() => readAutoSync(), [tick])
  const alerts = useMemo(
    () =>
      buildAlerts({
        today,
        cards: readCardsCache(),
        overview: readOverviewCache(),
        txs,
        pace,
        rentMissing: rentMissingNow(user, txs, today),
        balanceChecks: checkBalances(readBalanceSnapshots(), txs),
      }).filter((a) => !dismissed[a.id]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [txs, today, pace, dismissed, tick, user],
  )
  const dismiss = (id: string) => {
    const next = { ...dismissed, [id]: today }
    setDismissed(next)
    try {
      localStorage.setItem(DISMISS, JSON.stringify(next))
    } catch {
      /* sem armazenamento */
    }
  }
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? alerts : alerts.slice(0, 3)

  if (!alerts.length && !(hasOf && sync && (sync.fresh > 0 || sync.saved || sync.confirmed || sync.removed || sync.error))) return null
  return (
    <section className="space-y-2" aria-label="Alertas">
      {hasOf && sync && sync.fresh > 0 ? (
        <Link to="/import?of=1" className="flex items-center gap-3 rounded-2xl bg-accent-muted p-3 text-sm">
          <Landmark className="size-4 shrink-0" />
          <span className="flex-1">
            <b>{sync.fresh} lançamento(s) novo(s)</b> nos bancos desde a última importação. Revisar e salvar
          </span>
          <ChevronRight className="size-4" />
        </Link>
      ) : null}
      {hasOf && sync?.error ? (
        <Link to="/open-finance" className="flex items-start gap-2 rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <Landmark className="mt-0.5 size-3.5 shrink-0" />
          <span>
            A busca nos bancos falhou: {sync.error} <b className="underline">Abrir Open Finance</b>
          </span>
        </Link>
      ) : null}
      {hasOf && sync && (sync.saved || sync.confirmed || sync.removed) ? (
        <p className="flex items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-2 text-xs text-muted">
          <Landmark className="size-3.5 shrink-0" />
          <span>
            Bancos sincronizados {new Date(sync.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            {sync.saved ? ` · ${sync.saved} novo(s) salvo(s)` : ''}
            {sync.confirmed ? ` · ${sync.confirmed} pendente(s) confirmado(s)` : ''}
            {sync.removed ? ` · ${sync.removed} pendente(s) cancelado(s) pelo banco` : ''}
          </span>
        </p>
      ) : null}
      {shown.map((a) => (
        <div
          key={a.id}
          className={cn(
            'flex items-start gap-3 rounded-2xl border p-3 text-sm',
            a.level === 'alta' ? 'border-danger/40 bg-danger/10' : 'border-border bg-surface',
          )}
        >
          {a.level === 'alta' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" /> : <Bell className="mt-0.5 size-4 shrink-0 text-muted" />}
          <div className="min-w-0 flex-1">
            {a.to ? (
              <Link to={a.to} className="font-semibold">
                {a.title}
              </Link>
            ) : (
              <p className="font-semibold">{a.title}</p>
            )}
            <p className="text-xs text-muted">{a.detail}</p>
          </div>
          <button type="button" aria-label="Dispensar alerta" onClick={() => dismiss(a.id)} className="rounded-full p-1 text-muted hover:bg-background">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {alerts.length > 3 ? (
        <button type="button" className="text-xs font-semibold underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Mostrar menos' : `Ver mais ${alerts.length - 3} alerta(s)`}
        </button>
      ) : null}
    </section>
  )
}
