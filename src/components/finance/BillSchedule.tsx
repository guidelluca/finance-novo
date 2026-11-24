import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { CalendarDays, ChevronDown, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useRecentTxs } from '@/hooks/useRecentTxs'
import { billSchedule, defaultRule, type DueRule } from '@/lib/billSchedule'
import { formatBRLFromCents } from '@/lib/currency'
import { readCardsCache } from '@/lib/openFinance'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const BR = formatBRLFromCents
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
const weekdayName = (d: string) => format(parseISO(d), 'EEE', { locale: ptBR }).replace('.', '')
const STATUS = {
  aberta: { label: 'aberta', cls: 'bg-[var(--series-1)]/15 text-[var(--series-1)]' },
  fechada: { label: 'fechada · a pagar', cls: 'bg-danger/10 text-danger' },
  paga: { label: 'paga', cls: 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]' },
  futura: { label: 'próxima', cls: 'bg-background text-muted' },
}

/** Próximas faturas de todos os cartões, na ordem em que vencem, com o total de cada mês. */
export function BillSchedule() {
  const { user } = useAuth()
  const { txs, loading } = useRecentTxs(420)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const saved = (user?.user_metadata?.card_due_rules ?? {}) as Record<string, DueRule>

  // cartão sem regra: usa o dia de vencimento que o banco informa (Open Finance)
  const rules = useMemo(() => {
    const r: Record<string, DueRule> = {}
    for (const c of readCardsCache()?.cards ?? []) {
      if (!c.dueDate) continue
      const label = `Cartão ${c.bank.replace(/^Banco\s+/i, '')}`
      r[label] = { kind: 'dia', day: Number(c.dueDate.slice(8, 10)), closeDaysBefore: 7 }
    }
    for (const t of txs) if (t.account && defaultRule(t.account)) r[t.account] = defaultRule(t.account)!
    return { ...r, ...saved }
  }, [txs, saved])

  const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)
  const bills = useMemo(() => billSchedule(txs, rules, today, 4).filter((b) => b.cents > 0 || b.status !== 'futura'), [txs, rules, today])
  const months = useMemo(() => {
    const m = new Map<string, { ym: string; cents: number; count: number }>()
    for (const b of bills) {
      if (b.status === 'paga') continue
      const ym = b.due.slice(0, 7)
      const x = m.get(ym) ?? { ym, cents: 0, count: 0 }
      x.cents += b.cents
      x.count += 1
      m.set(ym, x)
    }
    return [...m.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1))
  }, [bills])

  const cards = [...new Set(bills.map((b) => b.card))]
  const saveRule = async (card: string, rule: DueRule) => {
    await supabase.auth.updateUser({ data: { card_due_rules: { ...saved, [card]: rule } } })
  }

  return (
    <section className="rise space-y-3 rounded-3xl border border-border bg-surface p-4" aria-label="Próximas faturas">
      <header className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-xl bg-background">
          <CalendarDays className="size-3.5 text-muted" />
        </span>
        <h2 className="flex-1 text-sm font-semibold">Quando e quanto você vai pagar</h2>
        <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-muted" onClick={() => setEditing((v) => !v)}>
          <Settings2 className="size-3.5" /> vencimentos
        </button>
      </header>

      {editing ? (
        <ul className="space-y-2 rounded-2xl bg-background p-3 text-xs">
          {cards.map((card) => {
            const r = rules[card]
            return (
              <li key={card} className="flex flex-wrap items-center gap-2">
                <span className="w-28 truncate font-semibold">{card.replace(/^Cartão\s+/i, '')}</span>
                <select
                  value={r?.kind === 'ultimo_util' ? 'ultimo' : String(r?.kind === 'dia' ? r.day : 15)}
                  onChange={(e) =>
                    void saveRule(
                      card,
                      e.target.value === 'ultimo' ? { kind: 'ultimo_util', closeDaysBefore: r?.closeDaysBefore ?? 7 } : { kind: 'dia', day: Number(e.target.value), closeDaysBefore: r?.closeDaysBefore ?? 7 },
                    )
                  }
                  className="h-8 rounded-lg border border-border bg-surface px-2"
                  aria-label={`Vencimento do ${card}`}
                >
                  <option value="ultimo">vence no último dia útil</option>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      vence dia {d}
                    </option>
                  ))}
                </select>
                <select
                  value={r?.closeDaysBefore ?? 7}
                  onChange={(e) => void saveRule(card, { ...(r ?? { kind: 'dia', day: 15 }), closeDaysBefore: Number(e.target.value) } as DueRule)}
                  className="h-8 rounded-lg border border-border bg-surface px-2"
                  aria-label={`Fechamento do ${card}`}
                >
                  {[5, 6, 7, 8, 9, 10].map((d) => (
                    <option key={d} value={d}>
                      fecha {d} dias antes
                    </option>
                  ))}
                </select>
              </li>
            )
          })}
          <li className="text-[11px] text-muted">Vencimento em sábado, domingo passa para o próximo dia útil.</li>
        </ul>
      ) : null}

      {loading ? <p className="text-xs text-muted">Carregando…</p> : null}

      {months.length ? (
        <div className="grid grid-cols-2 gap-2">
          {months.slice(0, 4).map((m, i) => (
            <div key={m.ym} className={cn('rounded-2xl p-3', i === 0 ? 'bg-ink text-[#f2f3ee]' : 'bg-background')}>
              <p className={cn('text-[11px] first-letter:uppercase', i === 0 ? 'text-[#b9bdb4]' : 'text-muted')}>
                {format(parseISO(`${m.ym}-01`), "LLLL 'de' yyyy", { locale: ptBR })}
              </p>
              <p className="text-lg font-semibold tabular-nums">{BR(m.cents)}</p>
              <p className={cn('text-[11px]', i === 0 ? 'text-[#b9bdb4]' : 'text-muted')}>{m.count} fatura(s)</p>
            </div>
          ))}
        </div>
      ) : null}

      <ol className="space-y-1.5">
        {bills.map((b) => {
          const key = `${b.card}|${b.due}`
          const st = STATUS[b.status]
          const isOpen = open === key
          return (
            <li key={key} className="rounded-2xl bg-background">
              <button type="button" className="flex w-full items-center gap-3 p-2.5 text-left" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                <span className="flex w-11 shrink-0 flex-col items-center rounded-xl bg-surface py-1">
                  <span className="text-[10px] uppercase text-muted">{weekdayName(b.due)}</span>
                  <span className="text-sm font-bold leading-none tabular-nums">{ddmm(b.due)}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{b.card.replace(/^Cartão\s+/i, '')}</span>
                  <span className="block text-[11px] text-muted">
                    compras de {ddmm(b.from)} a {ddmm(b.close)}
                    {b.installmentsCents ? ` · ${BR(b.installmentsCents)} em parcelas` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums">{BR(b.cents)}</span>
                  <span className={cn('mt-0.5 inline-block rounded-full px-1.5 py-px text-[10px] font-semibold', st.cls)}>{st.label}</span>
                </span>
                <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
              </button>
              {isOpen ? (
                <ul className="space-y-0.5 px-3 pb-2.5 text-[11px]">
                  {b.items.length ? (
                    b.items.map((it, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate">
                          {ddmm(it.date)} · {it.description.replace(/\s+·\s+(pendente|prevista)$/i, '')}
                          {it.projected ? <span className="text-muted"> · prevista</span> : null}
                        </span>
                        <span className="shrink-0 tabular-nums">{BR(it.cents)}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-muted">Nada nesse ciclo ainda.</li>
                  )}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className="text-[11px] text-muted">
        Soma as compras salvas de cada ciclo e as parcelas que caem nele. Fatura aberta ainda pode crescer até o fechamento. Itaú: último dia útil; Inter e
        PicPay: dia 15. Ajuste em “vencimentos”.
      </p>
    </section>
  )
}
