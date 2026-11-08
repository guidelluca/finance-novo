import { differenceInCalendarMonths, format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Plus, Target } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { parseBRLToCents, readGoalDeadlines, saveGoalDeadline } from '@/lib/budgets'
import { formatBRLFromCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

type Goal = { id: string; name: string; target_cents: number | null; sort_order: number; created_at: string }
type Entry = { id: string; goal_id: string; date: string; amount_cents: number; note: string | null }

const brl0 = (c: number) => formatBRLFromCents(c).replace(/,00$/, '')
const RING = 2 * Math.PI * 46

function monthLabel(ym: string) {
  return format(parseISO(`${ym}-01`), 'LLLL yyyy', { locale: ptBR })
}

export function GoalsPage() {
  const { user } = useAuth()
  const [goals, setGoals] = useState<Goal[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', target: '', deadline: '' })
  const [contrib, setContrib] = useState<{ goalId: string; value: string; dir: 'in' | 'out' } | null>(null)
  const [busy, setBusy] = useState(false)
  const deadlines = readGoalDeadlines(user)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const [g, e] = await Promise.all([
      supabase.from('savings_goals').select('*').eq('user_id', user.id).order('sort_order'),
      supabase.from('savings_entries').select('*').eq('user_id', user.id).order('date', { ascending: false }),
    ])
    if (g.error || e.error) setError((g.error ?? e.error)!.message)
    setGoals((g.data ?? []) as Goal[])
    setEntries((e.data ?? []) as Entry[])
    setLoading(false)
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const saved = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries) m.set(e.goal_id, (m.get(e.goal_id) ?? 0) + e.amount_cents)
    return m
  }, [entries])
  const totalSaved = [...saved.values()].reduce((s, v) => s + v, 0)
  const thisMonth = format(new Date(), 'yyyy-MM')
  const monthIn = entries.filter((e) => e.date.startsWith(thisMonth) && e.amount_cents > 0).reduce((s, e) => s + e.amount_cents, 0)

  // meta principal: a que tem prazo mais próximo; senão a de maior alvo
  const main =
    [...goals].filter((g) => deadlines[g.id] && g.target_cents).sort((a, b) => (deadlines[a.id]! < deadlines[b.id]! ? -1 : 1))[0] ??
    [...goals].filter((g) => g.target_cents).sort((a, b) => (b.target_cents ?? 0) - (a.target_cents ?? 0))[0] ??
    goals[0]
  const others = goals.filter((g) => g.id !== main?.id)

  const perMonthNeeded = (g: Goal): number | null => {
    const dl = deadlines[g.id]
    if (!dl || !g.target_cents) return null
    const left = g.target_cents - (saved.get(g.id) ?? 0)
    if (left <= 0) return 0
    const months = Math.max(1, differenceInCalendarMonths(parseISO(`${dl}-01`), new Date()))
    return Math.ceil(left / months)
  }

  const addGoal = async () => {
    if (!user || !form.name.trim()) return
    setBusy(true)
    const target = parseBRLToCents(form.target)
    const { data, error: err } = await supabase
      .from('savings_goals')
      .insert({ user_id: user.id, name: form.name.trim(), target_cents: target && target > 0 ? target : null, sort_order: goals.length })
      .select('id')
      .single()
    if (!err && data && form.deadline) await saveGoalDeadline(user, data.id, form.deadline)
    setBusy(false)
    if (err) setError(err.message)
    else {
      setAdding(false)
      setForm({ name: '', target: '', deadline: '' })
      void load()
    }
  }

  const addEntry = async () => {
    if (!user || !contrib) return
    const c = parseBRLToCents(contrib.value)
    if (!c) return
    setBusy(true)
    const { error: err } = await supabase.from('savings_entries').insert({
      user_id: user.id,
      goal_id: contrib.goalId,
      date: format(new Date(), 'yyyy-MM-dd'),
      amount_cents: contrib.dir === 'in' ? c : -c,
      note: null,
    })
    setBusy(false)
    if (err) setError(err.message)
    else {
      setContrib(null)
      void load()
    }
  }

  const contribForm = (g: Goal) =>
    contrib?.goalId === g.id ? (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl bg-background p-1 text-xs">
          {(['in', 'out'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setContrib({ ...contrib, dir: d })}
              className={cn('rounded-lg px-2.5 py-1.5 font-semibold', contrib.dir === d ? 'bg-surface shadow-sm' : 'text-muted')}
            >
              {d === 'in' ? 'Guardar' : 'Retirar'}
            </button>
          ))}
        </div>
        <input
          autoFocus
          inputMode="decimal"
          placeholder="R$ 0,00"
          value={contrib.value}
          onChange={(e) => setContrib({ ...contrib, value: e.target.value })}
          className="h-10 w-28 rounded-xl border border-border bg-background px-3 text-right tabular-nums text-foreground"
        />
        <Button size="sm" onClick={() => void addEntry()} disabled={busy}>
          Salvar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setContrib(null)}>
          Cancelar
        </Button>
      </div>
    ) : null

  return (
    <div className="space-y-3.5 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[30px] font-bold tracking-tight">Metas</h1>
        <Button className="rounded-[14px]" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-4" /> Nova meta
        </Button>
      </header>

      {error ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}

      {adding ? (
        <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
          <label className="block space-y-1 text-[13px] text-muted">
            Nome
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Viagem Europa" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block space-y-1 text-[13px] text-muted">
              Quanto (R$)
              <input inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="15.000" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" />
            </label>
            <label className="block space-y-1 text-[13px] text-muted">
              Até quando
              <input type="month" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" />
            </label>
          </div>
          <Button className="w-full" onClick={() => void addGoal()} disabled={busy || !form.name.trim()}>
            Criar meta
          </Button>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1 rounded-[20px] border border-border bg-surface px-4 py-3.5">
          <p className="text-xs text-muted">Guardado no total</p>
          <p className="font-display text-2xl font-bold">{brl0(totalSaved)}</p>
        </div>
        <div className="space-y-1 rounded-[20px] border border-border bg-surface px-4 py-3.5">
          <p className="text-xs first-letter:uppercase text-muted">Aportado em {format(new Date(), 'LLL', { locale: ptBR })}</p>
          <p className="font-display text-2xl font-bold">{brl0(monthIn)}</p>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted">Carregando…</p> : null}
      {!loading && goals.length === 0 ? (
        <section className="rounded-3xl border border-dashed border-border p-6 text-center text-sm text-muted">
          Nenhuma meta ainda. Toque em <strong>Nova meta</strong> para começar.
        </section>
      ) : null}

      {main ? (() => {
        const s = saved.get(main.id) ?? 0
        const pct = main.target_cents ? Math.min(100, Math.round((s / main.target_cents) * 100)) : 0
        const need = perMonthNeeded(main)
        return (
          <section className="rounded-[28px] bg-ink p-5 text-[#f2f3ee]">
            <div className="flex items-center gap-[18px]">
              <div className="relative size-28 shrink-0">
                <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={`${pct}% da meta`}>
                  <circle cx="56" cy="56" r="46" fill="none" stroke="#2c3036" strokeWidth="12" />
                  <circle cx="56" cy="56" r="46" fill="none" stroke="#c8f169" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(RING * pct) / 100} ${RING}`} transform="rotate(-90 56 56)" />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center font-display text-2xl font-bold">{pct}%</span>
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs uppercase tracking-wider text-[#b9bdb4]">Meta principal</p>
                <p className="truncate font-display text-[22px] font-semibold">{main.name}</p>
                <p className="text-[13px] text-[#b9bdb4]">
                  {brl0(s)}
                  {main.target_cents ? ` de ${brl0(main.target_cents).replace('R$ ', '')}` : ''}
                  {deadlines[main.id] ? ` · ${monthLabel(deadlines[main.id]!)}` : ''}
                </p>
                {need != null ? (
                  <p className="text-[13px] font-semibold text-lime">{need === 0 ? 'Meta atingida!' : `${brl0(need)}/mês até lá`}</p>
                ) : null}
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setContrib({ goalId: main.id, value: '', dir: 'in' })} className="min-h-10 rounded-xl bg-lime px-4 text-sm font-semibold text-ink">
                Guardar dinheiro
              </button>
            </div>
            {contribForm(main)}
          </section>
        )
      })() : null}

      {others.length ? (
        <section className="space-y-2.5">
          {others.map((g, i) => {
            const s = saved.get(g.id) ?? 0
            const pct = g.target_cents ? Math.min(100, Math.round((s / g.target_cents) * 100)) : null
            const colors = ['#2F5BD3', '#166534', '#9A3412', '#6B21A8'][i % 4]!
            return (
              <div key={g.id} className="space-y-3 rounded-[22px] border border-border bg-surface p-4">
                <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setContrib({ goalId: g.id, value: '', dir: 'in' })}>
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${colors}22`, color: colors }}>
                    <Target className="size-5" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{g.name}</span>
                    <span className="block text-xs text-muted">
                      {brl0(s)}
                      {g.target_cents ? ` de ${brl0(g.target_cents)}` : ''} · {deadlines[g.id] ? monthLabel(deadlines[g.id]!) : 'sem prazo'}
                    </span>
                  </span>
                  {pct != null ? <span className="text-sm font-semibold">{pct}%</span> : null}
                </button>
                {pct != null ? (
                  <div className="h-2 rounded-full bg-[#eeefe9] dark:bg-[#2b2e34]">
                    <div className="h-2 rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: colors }} />
                  </div>
                ) : null}
                {contribForm(g)}
              </div>
            )
          })}
        </section>
      ) : null}

      {entries.length ? (
        <section className="rounded-3xl border border-border bg-surface px-1.5 py-2">
          <h2 className="px-3 pb-1.5 pt-3 text-lg font-semibold">Últimos aportes</h2>
          {entries.slice(0, 5).map((e, i) => (
            <div key={e.id} className={cn('flex justify-between px-3 py-2.5 text-sm', i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
              <span className="truncate">
                {goals.find((g) => g.id === e.goal_id)?.name ?? 'Meta'} · {format(parseISO(e.date), 'd MMM', { locale: ptBR })}
              </span>
              <span className={cn('font-semibold tabular-nums', e.amount_cents >= 0 ? 'text-positive' : 'text-danger')}>
                {e.amount_cents >= 0 ? '+' : '−'}
                {brl0(Math.abs(e.amount_cents))}
              </span>
            </div>
          ))}
          <Link to="/savings" className="block px-3 pb-2 pt-1 text-[13px] font-semibold text-[#2f5bd3] dark:text-[#8fb0ff]">
            Ver tudo e gerenciar
          </Link>
        </section>
      ) : null}
    </div>
  )
}
