import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronRight, CreditCard as CardIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { currentOpenBill, daysUntil, nextBill, sumBillCents } from '@/lib/creditCards'
import { formatBRLFromCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import type { CreditCard, Transaction } from '@/types/database'

interface Props {
  userId: string
}

export function CardsQuickOverview({ userId }: Props) {
  const [cards, setCards] = useState<CreditCard[]>([])
  const [txs, setTxs] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const [{ data: c }, { data: t }] = await Promise.all([
        supabase
          .from('credit_cards')
          .select('*')
          .eq('user_id', userId)
          .eq('archived', false)
          .order('sort_order')
          .order('name'),
        supabase
          .from('transactions')
          .select('*')
          .eq('user_id', userId)
          .not('credit_card_id', 'is', null)
          .order('date', { ascending: false })
          .limit(1000),
      ])
      if (cancelled) return
      setCards((c as CreditCard[]) ?? [])
      setTxs((t as Transaction[]) ?? [])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const rows = useMemo(() => {
    return cards.map((card) => {
      const current = currentOpenBill(card)
      const upcoming = nextBill(card)
      return {
        card,
        current,
        upcoming,
        currentTotal: sumBillCents(txs, current),
        upcomingTotal: sumBillCents(txs, upcoming),
      }
    })
  }, [cards, txs])

  const totalCurrent = rows.reduce((sum, r) => sum + r.currentTotal, 0)

  if (loading) return null
  if (rows.length === 0) return null

  return (
    <Card className="border-border/70 bg-surface-elevated/60">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted">Cartões de crédito</p>
          <CardTitle className="mt-0.5 flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
            <span className="tabular-nums">{formatBRLFromCents(totalCurrent)}</span>
            <span className="text-sm font-normal text-muted">nas faturas em aberto</span>
          </CardTitle>
        </div>
        <Link
          to="/cards"
          className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
        >
          Ver todos <ChevronRight className="size-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.slice(0, 4).map(({ card, current, currentTotal }) => {
          const color = card.color || '#14161a'
          const pct =
            card.limit_cents && card.limit_cents > 0
              ? Math.min(100, Math.round((currentTotal / card.limit_cents) * 100))
              : null
          return (
            <Link
              key={card.id}
              to="/cards"
              className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface p-2.5 transition hover:border-accent/40"
            >
              <div
                className="grid size-9 shrink-0 place-items-center rounded-lg text-white"
                style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
              >
                <CardIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">{card.name}</p>
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    {formatBRLFromCents(currentTotal)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {pct != null ? (
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  ) : (
                    <span className="text-[10px] text-muted">sem limite definido</span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted">
                    fecha {formatShort(current.closingIso)} · em {daysUntil(current.closingIso)}d
                  </span>
                </div>
              </div>
            </Link>
          )
        })}
        {rows.length > 4 ? (
          <p className="text-center text-[11px] text-muted">
            +{rows.length - 4} cartão(ões). <Link className="text-accent" to="/cards">Ver todos</Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function formatShort(iso: string): string {
  try {
    return format(parseISO(iso), "d MMM", { locale: ptBR })
  } catch {
    return iso
  }
}
