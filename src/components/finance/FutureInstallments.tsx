import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { CalendarClock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatBRLFromCents } from '@/lib/currency'
import { projectInstallments, type RowTx } from '@/lib/ofInsights'
import { cn } from '@/lib/utils'

const label = (ym: string) => format(parseISO(`${ym}-01`), "LLL'/'yy", { locale: ptBR })

/** Quanto das próximas faturas já está comprometido com parcelas de compras já feitas. */
export function FutureInstallments({ txs, today }: { txs: RowTx[]; today: string }) {
  const months = useMemo(() => projectInstallments(txs, today), [txs, today])
  const [open, setOpen] = useState<string | null>(null)
  const max = Math.max(1, ...months.map((m) => m.cents))
  const total = months.reduce((s, m) => s + m.cents, 0)
  return (
    <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-muted" />
        <h2 className="flex-1 text-sm font-semibold">Parcelas que ainda vão cair</h2>
        {total ? <span className="text-xs font-semibold tabular-nums">{formatBRLFromCents(total)}</span> : null}
      </div>
      {!months.length ? (
        <p className="text-xs text-muted">Nenhuma compra parcelada com parcelas pela frente nos lançamentos salvos.</p>
      ) : (
        <ul className="space-y-1.5">
          {months.map((m) => (
            <li key={m.ym}>
              <button type="button" className="w-full text-left" onClick={() => setOpen(open === m.ym ? null : m.ym)}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-14 shrink-0 font-medium first-letter:uppercase">{label(m.ym)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-border/60">
                    <span className="block h-full rounded-full bg-[var(--series-4)]" style={{ width: `${(m.cents / max) * 100}%` }} />
                  </span>
                  <span className="w-24 shrink-0 text-right tabular-nums">{formatBRLFromCents(m.cents)}</span>
                </div>
              </button>
              <ul className={cn('mt-1 space-y-0.5 pl-16 text-[11px] text-muted', open !== m.ym && 'hidden')}>
                {m.items.map((it, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      {it.name} · {it.n}/{it.of} · {it.account}
                    </span>
                    <span className="tabular-nums">{formatBRLFromCents(it.cents)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted">Mês aproximado: depende do dia de fechamento de cada cartão. Toque num mês para ver as compras.</p>
    </section>
  )
}
