import { CreditCard, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { ofCards, readCardsCache, readConnections, splitCardUsage, type OfCard } from '@/lib/openFinance'
import { cn } from '@/lib/utils'

const BR = formatBRLFromCents
const BR0 = (c: number) => formatBRLFromCents(c).replace(/,\d{2}$/, '')
const br = (iso: string | null) => (iso ? iso.slice(5, 10).split('-').reverse().join('/') : '—')
const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 100) : 0)

/** As 3 partes do limite usado + o que sobra. Cores fixas (mesma parte = mesma cor em todos os cartões). */
const PARTS = [
  { key: 'closed', label: 'Fatura fechada', color: 'var(--series-2)', fg: '#ffffff' },
  { key: 'open', label: 'Fatura do mês', color: 'var(--series-1)', fg: '#ffffff' },
  { key: 'future', label: 'Parcelas futuras', color: 'var(--series-4)', fg: '#14161a' },
] as const

type Usage = { used: number; closed: number; open: number; future: number; limit: number | null; avail: number | null }

function usageOf(c: OfCard, today: string): Usage {
  const u = splitCardUsage(c, today)
  const limit = c.limitCents ?? (c.availableCents != null ? c.availableCents + u.used : null)
  const avail = c.availableCents ?? (limit != null ? Math.max(0, limit - u.used) : null)
  return { used: u.used, closed: u.closedUnpaid, open: u.open, future: u.future, limit, avail }
}

/** Barra do limite com os valores escritos dentro de cada parte (quando cabe) e régua de 0 até o limite. */
function LimitBar({ u, dark = false, tall = false }: { u: Usage; dark?: boolean; tall?: boolean }) {
  const base = Math.max(1, u.limit ?? u.used)
  const segs = [
    { ...PARTS[0], v: u.closed },
    { ...PARTS[1], v: u.open },
    { ...PARTS[2], v: u.future },
  ].filter((s) => s.v > 0)
  const usedPct = pct(u.used, base)
  return (
    <div className="space-y-1">
      <div
        className={cn('flex gap-[2px] overflow-hidden rounded-xl', tall ? 'h-9' : 'h-7', dark ? 'bg-white/10' : 'bg-border/60')}
        role="img"
        aria-label={`Usado ${BR(u.used)}${u.limit ? ` de ${BR(u.limit)} (${usedPct}%)` : ''}`}
      >
        {segs.map((s) => {
          const w = (s.v / base) * 100
          return (
            <span
              key={s.key}
              className="flex h-full min-w-[3px] items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[11px] font-semibold"
              style={{ width: `${w}%`, background: s.color, color: s.fg }}
              title={`${s.label}: ${BR(s.v)}`}
            >
              {w >= 16 ? BR0(s.v) : ''}
            </span>
          )
        })}
        {u.avail != null && u.avail > 0 ? (
          <span
            className={cn('flex h-full flex-1 items-center justify-end px-2 text-[11px] font-medium', dark ? 'text-[#b9bdb4]' : 'text-muted')}
            title={`Disponível: ${BR(u.avail)}`}
          >
            {(u.avail / base) * 100 >= 22 ? `${BR0(u.avail)} livre` : ''}
          </span>
        ) : null}
      </div>
      <div className={cn('flex justify-between text-[11px] tabular-nums', dark ? 'text-[#b9bdb4]' : 'text-muted')}>
        <span>
          usado <b className={dark ? 'text-[#f2f3ee]' : 'text-foreground'}>{BR(u.used)}</b> · {usedPct}%
        </span>
        <span>limite {u.limit != null ? BR(u.limit) : '—'}</span>
      </div>
    </div>
  )
}

function Legend({ u, dark = false }: { u: Usage; dark?: boolean }) {
  const rows = [
    { ...PARTS[0], v: u.closed },
    { ...PARTS[1], v: u.open },
    { ...PARTS[2], v: u.future },
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-2">
          <dt className={cn('flex items-center gap-1.5', dark ? 'text-[#b9bdb4]' : 'text-muted')}>
            <i className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
            {r.label}
          </dt>
          <dd className="font-semibold tabular-nums">{BR(r.v)}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <dt className={cn('flex items-center gap-1.5', dark ? 'text-[#b9bdb4]' : 'text-muted')}>
          <i className={cn('size-2 shrink-0 rounded-full border', dark ? 'border-white/40' : 'border-muted')} />
          Disponível
        </dt>
        <dd className="font-semibold tabular-nums">{u.avail != null ? BR(u.avail) : '—'}</dd>
      </div>
    </dl>
  )
}

/**
 * Cartões pelo Open Finance: consolidado de todos + um bloco por cartão.
 * O limite usado se divide em fatura fechada (a pagar) · fatura do mês (aberta) · parcelas futuras.
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
  const cards = (data?.cards ?? []).map((c) => ({ c, u: usageOf(c, today) }))
  const total: Usage = cards.reduce<Usage>(
    (t, { u }) => ({
      used: t.used + u.used,
      closed: t.closed + u.closed,
      open: t.open + u.open,
      future: t.future + u.future,
      limit: u.limit != null ? (t.limit ?? 0) + u.limit : t.limit,
      avail: u.avail != null ? (t.avail ?? 0) + u.avail : t.avail,
    }),
    { used: 0, closed: 0, open: 0, future: 0, limit: null, avail: null },
  )
  const toPay = total.closed + total.open
  const nextDue = cards
    .map(({ c }) => c.dueDate)
    .filter((d): d is string => Boolean(d && d >= today))
    .sort()[0]

  return (
    <section className="space-y-3" aria-label="Limite e faturas dos cartões">
      <div className="flex items-center gap-2">
        <CreditCard className="size-4 text-muted" />
        <h2 className="flex-1 text-sm font-semibold">Limite e faturas</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium"
        >
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          {data ? 'Atualizar' : 'Buscar nos bancos'}
        </button>
      </div>
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">{err}</p> : null}

      {!data ? (
        <p className="rounded-2xl border border-border bg-surface p-3 text-xs text-muted">
          Toque em “Buscar nos bancos” para ver limite e fatura de cada cartão conectado.
        </p>
      ) : cards.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface p-3 text-xs text-muted">Nenhum cartão de crédito nas conexões do Open Finance.</p>
      ) : (
        <>
          {/* consolidado */}
          <div className="rise space-y-4 rounded-[28px] bg-ink p-5 text-[#f2f3ee]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] text-[#b9bdb4]">Todos os cartões · {cards.length}</p>
                <p className="font-display text-[34px] font-bold leading-none tracking-[-0.5px]">{BR(toPay)}</p>
                <p className="mt-1 text-xs text-[#b9bdb4]">
                  a pagar nas faturas{nextDue ? ` · próximo vencimento ${br(nextDue)}` : ''}
                </p>
              </div>
              {total.limit ? (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1.5 text-xs font-semibold text-ink',
                    pct(total.used, total.limit) <= 30 ? 'bg-lime' : pct(total.used, total.limit) <= 70 ? 'bg-[#f5c451]' : 'bg-[#f28c6b]',
                  )}
                  title="Limite usado somando todos os cartões (inclui parcelas futuras)"
                >
                  {pct(total.used, total.limit)}% do limite
                </span>
              ) : null}
            </div>
            <LimitBar u={total} dark tall />
            <Legend u={total} dark />
          </div>

          {/* por cartão */}
          <ul className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
            {cards.map(({ c, u }) => {
              const used = u.limit ? pct(u.used, u.limit) : null
              return (
                <li key={c.accountId} className="rise space-y-3 rounded-3xl border border-border bg-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {c.bank}
                        {c.number ? <span className="font-normal text-muted"> •{String(c.number).replace(/\D/g, '').slice(-4)}</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted">{c.name}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-muted">fatura do mês</p>
                      <p className="text-lg font-semibold leading-tight tabular-nums">{BR(u.open + u.closed)}</p>
                    </div>
                  </div>
                  <LimitBar u={u} />
                  {!compact ? <Legend u={u} /> : null}
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded-full bg-background px-2 py-1">fecha {br(c.closeDate)}</span>
                    <span className="rounded-full bg-background px-2 py-1">vence {br(c.dueDate)}</span>
                    {used != null ? (
                      <span
                        className={cn(
                          'rounded-full px-2 py-1 font-semibold',
                          used <= 30 ? 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]' : used <= 70 ? 'bg-[#fff6dc] text-[#7a5300] dark:bg-[#2d2612] dark:text-[#f5c451]' : 'bg-danger/10 text-danger',
                        )}
                      >
                        {used}% do limite
                      </span>
                    ) : null}
                    {c.minimumPaymentCents ? <span className="rounded-full bg-background px-2 py-1 text-muted">mínimo {BR0(c.minimumPaymentCents)} (evite)</span> : null}
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="text-[11px] text-muted">
            Limite usado = fatura fechada + fatura do mês + parcelas que ainda vão cair. A fatura do mês é calculada pelas compras desde o fechamento
            (aproximada); limite e disponível vêm do banco. Atualizado em {new Date(data.at).toLocaleString('pt-BR')}.
            {compact ? (
              <>
                {' '}
                <Link to="/cards" className="underline">
                  Ver nos cartões
                </Link>
              </>
            ) : null}
          </p>
        </>
      )}
    </section>
  )
}
