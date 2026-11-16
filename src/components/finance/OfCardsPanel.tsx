import { CreditCard, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { ofCards, readCardsCache, readConnections, splitCardUsage } from '@/lib/openFinance'
import { cn } from '@/lib/utils'

const br = (iso: string | null) => (iso ? iso.slice(5, 10).split('-').reverse().join('/') : '—')

/**
 * Por cartão, separa o que o banco chama de "limite usado" em:
 *  fatura fechada (a pagar) · fatura do mês (ciclo aberto) · resto (parcelas futuras e compras que vão para as próximas faturas).
 */
export function OfCardsPanel({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth()
  const conns = readConnections(user)
  const [data, setData] = useState(() => readCardsCache())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!conns.length) return null

  async function refresh() {
    setBusy(true)
    setErr(null)
    try {
      const r = await ofCards(conns)
      setData({ at: new Date().toISOString(), ...r })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const today = data?.today ?? new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)

  return (
    <section className="space-y-2.5 rounded-3xl bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <CreditCard className="size-4 text-muted" />
        <h2 className="flex-1 text-sm font-semibold">Limite consumido × fatura do mês</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs font-medium"
        >
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          {data ? 'Atualizar' : 'Buscar nos bancos'}
        </button>
      </div>
      {!compact ? (
        <p className="text-xs text-muted">
          O limite usado inclui tudo que ainda vai ser cobrado (parcelas futuras também). A fatura do mês é só o que fecha neste ciclo.
        </p>
      ) : null}
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">{err}</p> : null}
      {!data ? (
        <p className="text-xs text-muted">Toque em “Buscar nos bancos” para ver limite e fatura de cada cartão conectado.</p>
      ) : data.cards.length === 0 ? (
        <p className="text-xs text-muted">Nenhum cartão de crédito nas conexões do Open Finance.</p>
      ) : (
        <ul className="space-y-3">
          {data.cards.map((c) => {
            const u = splitCardUsage(c, today)
            const limit = c.limitCents ?? (c.availableCents != null ? c.availableCents + u.used : null)
            const avail = c.availableCents ?? (limit != null ? Math.max(0, limit - u.used) : null)
            const base = Math.max(1, limit ?? u.used)
            const seg = [
              { k: 'Fatura fechada a pagar', v: u.closedUnpaid, cls: 'bg-danger' },
              { k: 'Fatura do mês (aberta)', v: u.open, cls: 'bg-[var(--series-1)]' },
              { k: 'Parcelas futuras / próximas faturas', v: u.future, cls: 'bg-[var(--series-4)]' },
            ]
            return (
              <li key={c.accountId} className="rounded-2xl bg-background p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">
                    {c.bank} · {c.name} {c.number ? `•${String(c.number).replace(/\D/g, '').slice(-4)}` : ''}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    fecha {br(c.closeDate)} · vence {br(c.dueDate)}
                  </span>
                </div>
                <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-border/60" aria-hidden>
                  {seg.map((s) => (
                    <span key={s.k} className={cn('h-full', s.cls)} style={{ width: `${Math.min(100, (s.v / base) * 100)}%` }} />
                  ))}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted">Limite consumido</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatBRLFromCents(u.used)}</dd>
                  {u.closedUnpaid ? (
                    <>
                      <dt className="flex items-center gap-1.5 text-muted">
                        <span className="size-2 rounded-full bg-danger" /> Fatura fechada a pagar
                      </dt>
                      <dd className="text-right tabular-nums">{formatBRLFromCents(u.closedUnpaid)}</dd>
                    </>
                  ) : null}
                  <dt className="flex items-center gap-1.5 text-muted">
                    <span className={cn('size-2 rounded-full', seg[1]!.cls)} /> Fatura do mês (aberta, aprox.)
                  </dt>
                  <dd className="text-right font-semibold tabular-nums">{formatBRLFromCents(u.open)}</dd>
                  <dt className="flex items-center gap-1.5 text-muted">
                    <span className={cn('size-2 rounded-full', seg[2]!.cls)} /> Parcelas futuras e próximas faturas
                  </dt>
                  <dd className="text-right tabular-nums">{formatBRLFromCents(u.future)}</dd>
                  {avail != null ? (
                    <>
                      <dt className="text-muted">Disponível{limit != null ? ` de ${formatBRLFromCents(limit)}` : ''}</dt>
                      <dd className="text-right tabular-nums">{formatBRLFromCents(avail)}</dd>
                    </>
                  ) : null}
                  {u.lastBill ? (
                    <>
                      <dt className="text-muted">Última fatura fechada (venc. {br(u.lastBill.dueDate)})</dt>
                      <dd className="text-right tabular-nums">
                        {formatBRLFromCents(u.lastBill.totalCents)}
                        {u.lastBill.paidCents >= u.lastBill.totalCents && u.lastBill.totalCents ? ' · paga' : ''}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </li>
            )
          })}
        </ul>
      )}
      {data ? (
        <p className="text-[11px] text-muted">
          Atualizado em {new Date(data.at).toLocaleString('pt-BR')}. Nos totais do mês, cada compra continua contando na data em que foi feita.
          {compact ? (
            <>
              {' '}
              <Link to="/cards" className="underline">
                Ver nos cartões
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}
