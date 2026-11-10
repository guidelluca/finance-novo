import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Check, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { fetchLinkedTxs, planGoal, readGoalMeta, saveGoalMeta, suggestCuts, type LinkedTx } from '@/lib/goalPlan'
import { cn } from '@/lib/utils'

const brl0 = (c: number) => formatBRLFromCents(c).replace(/,00$/, '')
const monthShort = (ymStr: string) => format(parseISO(`${ymStr}-01`), "LLL'/'yy", { locale: ptBR })

type Props = {
  goal: { id: string; name: string; target_cents: number | null; created_at: string }
  deadline: string | null
  savedCents: number
  savedThisMonthCents: number
  today: string
  /** média dos últimos 3 meses por categoria (para sugerir cortes) */
  categoryAverages: { name: string; avgCents: number }[]
}

/** Plano da meta: quanto guardar por mês, ritmo, gastos já feitos (parcelas) e onde cortar. */
export function GoalPlanPanel({ goal, deadline, savedCents, savedThisMonthCents, today, categoryAverages }: Props) {
  const { user } = useAuth()
  const meta = readGoalMeta(user, goal.id, goal.name)
  const [linked, setLinked] = useState<LinkedTx[]>([])
  const [loading, setLoading] = useState(false)
  const [editKw, setEditKw] = useState(false)
  const [kwInput, setKwInput] = useState(meta.keywords.join(', '))
  const [showTx, setShowTx] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const kwKey = meta.keywords.join('|')

  useEffect(() => {
    if (!user || !meta.keywords.length) {
      setLinked([])
      return
    }
    let alive = true
    setLoading(true)
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
    fetchLinkedTxs(user.id, meta.keywords, since)
      .then((rows) => alive && setLinked(rows))
      .catch((e: Error) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, kwKey])

  const active = useMemo(() => linked.filter((t) => !meta.exclude.includes(t.id)), [linked, meta.exclude])
  const plan = useMemo(
    () =>
      planGoal({
        targetCents: goal.target_cents,
        savedCents,
        savedThisMonthCents,
        createdAt: goal.created_at.slice(0, 10),
        deadline,
        today,
        linked: active,
      }),
    [goal, savedCents, savedThisMonthCents, deadline, today, active],
  )
  const cuts = useMemo(() => {
    const short = plan.status === 'atrasado' ? Math.ceil(plan.gapCents / Math.max(1, plan.monthsLeft)) : 0
    // o que falta por mês além do que você já guarda neste mês
    const need = Math.max(short, plan.perMonthCents - plan.savedThisMonthCents)
    return suggestCuts(categoryAverages, need)
  }, [plan, categoryAverages])

  const target = goal.target_cents ?? 0
  const seg = (c: number) => (target ? `${Math.min(100, (c / target) * 100)}%` : '0%')

  const saveKeywords = async () => {
    if (!user) return
    const keywords = kwInput
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    try {
      await saveGoalMeta(user, goal.id, { keywords, exclude: meta.exclude })
      setEditKw(false)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const toggleExclude = async (id: string) => {
    if (!user) return
    const exclude = meta.exclude.includes(id) ? meta.exclude.filter((x) => x !== id) : [...meta.exclude, id]
    try {
      await saveGoalMeta(user, goal.id, { keywords: meta.keywords, exclude })
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const statusLine = {
    atingida: { ok: true, text: 'Meta coberta: guardado + já pago + parcelas somam o valor da meta.' },
    adiantado: { ok: true, text: `Adiantado: ${brl0(plan.gapCents)} à frente do ritmo para chegar em ${deadline ? monthShort(deadline) : ''}.` },
    no_ritmo: { ok: true, text: 'No ritmo para chegar no prazo.' },
    atrasado: {
      ok: false,
      text: `Atrasado: ${brl0(plan.gapCents)} abaixo do que já deveria ter (${brl0(plan.expectedByNowCents)} até este mês).`,
    },
    sem_prazo: { ok: true, text: 'Defina um valor e um prazo para eu montar o plano.' },
  }[plan.status]

  return (
    <div className="space-y-3 text-sm">
      {target ? (
        <div className="space-y-1.5">
          <div className="flex h-3 overflow-hidden rounded-full bg-[#eeefe9] dark:bg-[#2b2e34]" role="img" aria-label="Composição da meta">
            <div style={{ width: seg(savedCents), background: 'var(--series-3)' }} />
            <div style={{ width: seg(plan.paidCents), background: 'var(--series-4)' }} />
            <div style={{ width: seg(plan.committedCents), background: 'var(--series-2)' }} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-[var(--series-3)]" /> guardado {brl0(savedCents)}</span>
            {plan.paidCents ? <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-[var(--series-4)]" /> já pago {brl0(plan.paidCents)}</span> : null}
            {plan.committedCents ? <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-[var(--series-2)]" /> parcelas a pagar {brl0(plan.committedCents)}</span> : null}
            <span>falta {brl0(plan.remainingCashCents)}</span>
          </div>
        </div>
      ) : null}

      <p className={cn('flex items-start gap-1.5 font-medium', statusLine.ok ? 'text-[#3f5a12] dark:text-[#c8f169]' : 'text-[#9a3412] dark:text-[#ffb38a]')}>
        {statusLine.ok ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {statusLine.text}
      </p>

      {deadline && target && plan.status !== 'atingida' ? (
        <div className="space-y-1 rounded-2xl bg-background p-3">
          <p>
            Guardar <strong>{brl0(plan.perMonthCents)}/mês</strong> por {plan.monthsLeft} {plan.monthsLeft === 1 ? 'mês' : 'meses'} (até {monthShort(deadline)}).
          </p>
          <p className="text-xs text-muted">
            Este mês você guardou {brl0(plan.savedThisMonthCents)}
            {plan.savedThisMonthCents >= plan.perMonthCents ? ' — mês coberto.' : ` — faltam ${brl0(plan.perMonthCents - plan.savedThisMonthCents)}.`}
          </p>
          {plan.nextMonthInstallmentsCents ? (
            <p className="text-xs text-muted">
              Próximo mês: {brl0(plan.nextMonthInstallmentsCents)} de parcelas da meta + {brl0(plan.perMonthCents)} para guardar ={' '}
              <strong className="text-foreground">{brl0(plan.nextMonthInstallmentsCents + plan.perMonthCents)}</strong> saindo do seu orçamento.
            </p>
          ) : null}
        </div>
      ) : null}

      {plan.paidCents || plan.committedCents ? (
        <div className="space-y-1.5 rounded-2xl border border-[var(--series-4)]/40 p-3">
          <p className="font-semibold">Gastos já feitos para esta meta</p>
          <p className="text-xs text-muted">
            {plan.paidCents ? `${brl0(plan.paidCents)} já saíram do seu dinheiro (a meta andou, mas esse valor não está guardado). ` : ''}
            {plan.committedCents ? `${brl0(plan.committedCents)} em parcelas futuras já estão comprometidos — não precisa juntar esse valor, mas ele vai pesar nos próximos meses.` : ''}
          </p>
          {plan.installments.length ? (
            <ul className="space-y-0.5 text-xs">
              {plan.installments.map((i) => (
                <li key={`${i.name}${i.total}`} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {i.name} · {i.paid}/{i.total} pagas
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {brl0(i.perMonthCents)}/mês até {monthShort(i.lastMonth)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {cuts.length ? (
        <div className="space-y-1.5 rounded-2xl bg-background p-3">
          <p className="font-semibold">Como fechar a diferença</p>
          <ul className="space-y-0.5 text-xs">
            {cuts.map((c) => (
              <li key={c.name} className="flex justify-between gap-2">
                <span className="min-w-0 truncate">
                  {c.name}: média {brl0(c.avgCents)}/mês → cortar {c.pct}%
                </span>
                <span className="shrink-0 font-semibold tabular-nums">+{brl0(c.cutCents)}/mês</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">
            Baseado na média dos seus últimos 3 meses. Guarde o valor logo que o salário cair, antes de gastar.
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">
            {meta.keywords.length
              ? `Procurando gastos com: ${meta.keywords.slice(0, 6).join(', ')}${meta.keywords.length > 6 ? '…' : ''}`
              : 'Sem palavras para achar gastos desta meta.'}
          </span>
          <button type="button" className="font-semibold underline" onClick={() => setEditKw((v) => !v)}>
            {editKw ? 'Fechar' : 'Editar'}
          </button>
          {active.length || linked.length ? (
            <button type="button" className="font-semibold underline" onClick={() => setShowTx((v) => !v)}>
              {showTx ? 'Esconder' : `Ver ${linked.length} lançamento(s)`}
            </button>
          ) : null}
          {loading ? <span className="text-muted">procurando…</span> : null}
        </div>
        {editKw ? (
          <div className="flex gap-2">
            <input
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              placeholder="Ex.: latam, tap, booking, airbnb"
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-foreground"
            />
            <Button size="sm" className="h-10" onClick={() => void saveKeywords()}>
              Salvar
            </Button>
          </div>
        ) : null}
        {showTx ? (
          <ul className="space-y-1 text-xs">
            {linked.map((t) => {
              const off = meta.exclude.includes(t.id)
              return (
                <li key={t.id} className={cn('flex items-center gap-2', off && 'text-muted line-through')}>
                  <span className="min-w-0 flex-1 truncate">
                    {t.date.slice(8)}/{t.date.slice(5, 7)}/{t.date.slice(2, 4)} · {t.description}
                  </span>
                  <span className="shrink-0 tabular-nums">{brl0(t.amountCents)}</span>
                  <button type="button" onClick={() => void toggleExclude(t.id)} className="shrink-0 rounded-md p-1 hover:bg-background" aria-label={off ? 'É desta meta' : 'Não é desta meta'}>
                    {off ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
      {err ? <p className="text-xs text-danger">{err}</p> : null}
    </div>
  )
}
