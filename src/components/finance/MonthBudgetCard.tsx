import { differenceInDays, endOfMonth, format, isSameMonth, startOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Pencil, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getMonthBudgetCents, setMonthBudgetCents } from '@/lib/budgetSettings'
import { formatBRLFromCents } from '@/lib/currency'
import { cn } from '@/lib/utils'

interface Props {
  userId: string
  /** Data qualquer dentro do mês analisado. */
  month: Date
  /** Cents já gastos no mês (só saídas). */
  spentCents: number
  /** Cents entrados no mês (opcional; se passado, oferecemos usar como orçamento). */
  incomeCents?: number
  /** Total já comprometido em faturas de cartão que ainda não fecharam (cents). Opcional. */
  pendingCardsCents?: number
}

function parseBrAmountToCents(raw: string): number | null {
  const s = raw.replace(/\./g, '').replace(',', '.').trim()
  if (!s) return null
  const num = Number(s)
  if (Number.isNaN(num)) return null
  return Math.round(Math.abs(num) * 100)
}

function centsToBr(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

export function MonthBudgetCard({ userId, month, spentCents, incomeCents, pendingCardsCents }: Props) {
  const [budgetCents, setBudgetCents] = useState<number | null>(() =>
    getMonthBudgetCents(userId, month),
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setBudgetCents(getMonthBudgetCents(userId, month))
  }, [userId, month])

  const stats = useMemo(() => {
    const today = new Date()
    const start = startOfMonth(month)
    const end = endOfMonth(month)
    const totalDays = differenceInDays(end, start) + 1
    const isCurrent = isSameMonth(today, month)
    const dayOfMonth = isCurrent ? Math.min(totalDays, today.getDate()) : totalDays
    const remainingDays = Math.max(0, totalDays - dayOfMonth)

    const totalCommitted = spentCents + (pendingCardsCents ?? 0)
    const remaining = budgetCents != null ? Math.max(0, budgetCents - totalCommitted) : null
    const over = budgetCents != null ? Math.max(0, totalCommitted - budgetCents) : 0
    const pct = budgetCents ? Math.min(100, Math.round((totalCommitted / budgetCents) * 100)) : 0
    // "Ritmo diário sugerido" para chegar ao fim do mês dentro do orçamento
    const suggestedDaily =
      budgetCents != null && remainingDays > 0 && remaining != null ? Math.floor(remaining / remainingDays) : 0
    // Ritmo médio atual
    const avgSoFar = dayOfMonth > 0 ? Math.round(spentCents / dayOfMonth) : 0
    const projectedTotal = avgSoFar * totalDays

    return {
      totalDays,
      dayOfMonth,
      remainingDays,
      pct,
      remaining,
      over,
      suggestedDaily,
      avgSoFar,
      projectedTotal,
      totalCommitted,
      isCurrent,
    }
  }, [budgetCents, spentCents, pendingCardsCents, month])

  const startEdit = () => {
    setDraft(budgetCents != null ? centsToBr(budgetCents) : '')
    setEditing(true)
  }

  const save = () => {
    const cents = parseBrAmountToCents(draft)
    if (cents == null) {
      setEditing(false)
      return
    }
    setMonthBudgetCents(userId, month, cents)
    setBudgetCents(cents)
    setEditing(false)
  }

  const clear = () => {
    setMonthBudgetCents(userId, month, null)
    setBudgetCents(null)
    setEditing(false)
  }

  if (!budgetCents && !editing) {
    // Estado inicial sem orçamento: pequeno CTA
    return (
      <Card className="border-accent/30 bg-accent-muted/20">
        <CardContent className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">
              Defina um orçamento para {format(month, "MMMM 'de' yyyy", { locale: ptBR })}
            </p>
            <p className="text-xs text-muted">
              Vamos calcular quanto ainda dá para gastar e o ritmo diário sugerido.
            </p>
          </div>
          <div className="flex gap-2">
            {incomeCents ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setMonthBudgetCents(userId, month, incomeCents)
                  setBudgetCents(incomeCents)
                }}
              >
                Usar receita ({formatBRLFromCents(incomeCents)})
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={startEdit}>
              Definir
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const barColor =
    stats.pct < 75 ? 'bg-emerald-500' : stats.pct < 100 ? 'bg-amber-400' : 'bg-red-500'

  return (
    <Card className="border-border/70 bg-surface-elevated/60">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted">
              Orçamento · {format(month, "MMMM/yyyy", { locale: ptBR })}
            </p>
            <CardTitle className="mt-0.5 text-2xl font-semibold tracking-tight">
              {stats.remaining != null ? (
                <>
                  {formatBRLFromCents(stats.remaining)}{' '}
                  <span className="text-sm font-normal text-muted">disponível</span>
                </>
              ) : (
                formatBRLFromCents(spentCents)
              )}
            </CardTitle>
          </div>
          <Button type="button" size="sm" variant="ghost" className="text-muted" onClick={startEdit}>
            <Pencil className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {editing ? (
          <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
            <Label>Orçamento mensal (R$)</Label>
            <Input
              inputMode="decimal"
              autoFocus
              placeholder="Ex.: 3500,00"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={save}>
                Guardar
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              {budgetCents != null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="ml-auto text-danger hover:text-danger"
                  onClick={clear}
                >
                  Remover
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Barra de gasto */}
        <div className="space-y-1.5">
          <div className="h-3 w-full overflow-hidden rounded-full bg-border/60">
            <div
              className={cn('h-full transition-all', barColor)}
              style={{ width: `${stats.pct}%` }}
              aria-label={`${stats.pct}% do orçamento`}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted">
            <span>
              Gasto <strong className="text-foreground tabular-nums">{formatBRLFromCents(spentCents)}</strong>
              {pendingCardsCents ? (
                <> {' '}+ cartões em aberto {' '}
                  <strong className="text-foreground tabular-nums">{formatBRLFromCents(pendingCardsCents)}</strong>
                </>
              ) : null}
            </span>
            {budgetCents != null ? (
              <span>
                Orçamento{' '}
                <strong className="text-foreground tabular-nums">{formatBRLFromCents(budgetCents)}</strong>
              </span>
            ) : null}
          </div>
        </div>

        {/* Progresso do mês */}
        {stats.isCurrent ? (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/40">
              <div
                className="h-full rounded-full bg-accent/60"
                style={{ width: `${Math.round((stats.dayOfMonth / stats.totalDays) * 100)}%` }}
                aria-label="Progresso do mês"
              />
            </div>
            <p className="text-[11px] text-muted">
              Dia {stats.dayOfMonth} de {stats.totalDays} · faltam {stats.remainingDays} dia(s)
            </p>
          </div>
        ) : null}

        {/* Insights */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {stats.suggestedDaily > 0 ? (
            <div className="rounded-xl border border-border/70 bg-surface p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted">Podes gastar/dia</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {formatBRLFromCents(stats.suggestedDaily)}
              </p>
            </div>
          ) : null}
          {stats.isCurrent && stats.avgSoFar > 0 ? (
            <div className="rounded-xl border border-border/70 bg-surface p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted">Ritmo atual/dia</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {formatBRLFromCents(stats.avgSoFar)}
              </p>
            </div>
          ) : null}
          {stats.isCurrent && stats.projectedTotal > 0 && budgetCents != null ? (
            <div className="col-span-2 rounded-xl border border-border/70 bg-surface p-2.5">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="size-3.5 text-muted" aria-hidden />
                <p className="text-[10px] uppercase tracking-wide text-muted">Projeção fim do mês</p>
              </div>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {formatBRLFromCents(stats.projectedTotal)}{' '}
                <span
                  className={cn(
                    'ml-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    stats.projectedTotal > budgetCents
                      ? 'bg-red-500/15 text-danger'
                      : 'bg-positive/15 text-positive',
                  )}
                >
                  {stats.projectedTotal > budgetCents
                    ? `+${formatBRLFromCents(stats.projectedTotal - budgetCents)} acima`
                    : `${formatBRLFromCents(budgetCents - stats.projectedTotal)} de folga`}
                </span>
              </p>
            </div>
          ) : null}
        </div>

        {stats.over > 0 ? (
          <p className="rounded-xl border border-red-500/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            Ultrapassou o orçamento em{' '}
            <strong className="tabular-nums">{formatBRLFromCents(stats.over)}</strong>.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
