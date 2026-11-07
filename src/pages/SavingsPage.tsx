import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { PiggyBank, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import type { SavingsEntry, SavingsGoal } from '@/types/database'
import { cn } from '@/lib/utils'

function parseBrAmountToCents(raw: string): number | null {
  const s = raw.replace(/\./g, '').replace(',', '.').trim()
  const num = Number(s)
  if (Number.isNaN(num)) return null
  return Math.round(Math.abs(num) * 100)
}

function amountToBrInput(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2).replace('.', ',')
}

type Tab = 'boxes' | 'ledger'

export function SavingsPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('boxes')
  const [goals, setGoals] = useState<SavingsGoal[]>([])
  const [entries, setEntries] = useState<SavingsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [goalName, setGoalName] = useState('')
  const [goalTarget, setGoalTarget] = useState('')
  const [goalSubmitting, setGoalSubmitting] = useState(false)

  const [entryGoalId, setEntryGoalId] = useState('')
  const [entryDate, setEntryDate] = useState(() => format(new Date(), 'yyyy-MM-dd'))
  const [entryAmount, setEntryAmount] = useState('')
  const [entryDirection, setEntryDirection] = useState<'in' | 'out'>('in')
  const [entryNote, setEntryNote] = useState('')
  const [entrySubmitting, setEntrySubmitting] = useState(false)

  const [editingGoal, setEditingGoal] = useState<SavingsGoal | null>(null)
  const [editName, setEditName] = useState('')
  const [editTarget, setEditTarget] = useState('')

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    const [{ data: g, error: ge }, { data: e, error: ee }] = await Promise.all([
      supabase
        .from('savings_goals')
        .select('*')
        .eq('user_id', user.id)
        .order('sort_order')
        .order('name'),
      supabase
        .from('savings_entries')
        .select('*')
        .eq('user_id', user.id)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(800),
    ])
    if (ge) {
      setError(ge.message)
      setGoals([])
      setEntries([])
    } else {
      setGoals((g as SavingsGoal[]) ?? [])
    }
    if (ee) {
      setError(ee.message)
    } else if (!ge) {
      setEntries((e as SavingsEntry[]) ?? [])
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const goalById = useMemo(() => new Map(goals.map((x) => [x.id, x])), [goals])

  const balanceByGoal = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of entries) {
      const id = row.goal_id
      m.set(id, (m.get(id) ?? 0) + row.amount_cents)
    }
    return m
  }, [entries])

  const totalBalance = useMemo(
    () => [...balanceByGoal.values()].reduce((a, b) => a + b, 0),
    [balanceByGoal],
  )

  const addGoal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    const name = goalName.trim()
    if (!name) return
    let target_cents: number | null = null
    if (goalTarget.trim()) {
      const c = parseBrAmountToCents(goalTarget)
      if (c == null) {
        setError('Meta em valor inválido.')
        return
      }
      target_cents = c
    }
    setGoalSubmitting(true)
    setError(null)
    const nextOrder = goals.reduce((m, g) => Math.max(m, g.sort_order), -1) + 1
    const { error: insErr } = await supabase.from('savings_goals').insert({
      user_id: user.id,
      name,
      target_cents,
      sort_order: nextOrder,
    })
    setGoalSubmitting(false)
    if (insErr) {
      setError(insErr.message)
      return
    }
    setGoalName('')
    setGoalTarget('')
    void load()
  }

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !entryGoalId) return
    const cents = parseBrAmountToCents(entryAmount)
    if (cents == null || cents === 0) {
      setError('Valor inválido.')
      return
    }
    const signed = entryDirection === 'in' ? cents : -cents
    setEntrySubmitting(true)
    setError(null)
    const { error: insErr } = await supabase.from('savings_entries').insert({
      user_id: user.id,
      goal_id: entryGoalId,
      date: entryDate,
      amount_cents: signed,
      note: entryNote.trim() || null,
    })
    setEntrySubmitting(false)
    if (insErr) {
      setError(insErr.message)
      return
    }
    setEntryAmount('')
    setEntryNote('')
    void load()
  }

  const deleteGoal = async (g: SavingsGoal) => {
    if (!user) return
    if (
      !window.confirm(`Apagar a caixinha “${g.name}” e todo o histórico de movimentos? Isto não se pode desfazer.`)
    )
      return
    setError(null)
    const { error: delErr } = await supabase.from('savings_goals').delete().eq('id', g.id).eq('user_id', user.id)
    if (delErr) {
      setError(delErr.message)
      return
    }
    if (entryGoalId === g.id) setEntryGoalId('')
    void load()
  }

  const deleteEntry = async (row: SavingsEntry) => {
    if (!user) return
    if (!window.confirm('Apagar este movimento?')) return
    setError(null)
    const { error: delErr } = await supabase
      .from('savings_entries')
      .delete()
      .eq('id', row.id)
      .eq('user_id', user.id)
    if (delErr) {
      setError(delErr.message)
      return
    }
    void load()
  }

  const openEdit = (g: SavingsGoal) => {
    setEditingGoal(g)
    setEditName(g.name)
    setEditTarget(g.target_cents != null ? amountToBrInput(g.target_cents) : '')
  }

  const saveEdit = async () => {
    if (!user || !editingGoal) return
    const name = editName.trim()
    if (!name) return
    let target_cents: number | null = null
    if (editTarget.trim()) {
      const c = parseBrAmountToCents(editTarget)
      if (c == null) {
        setError('Meta inválida.')
        return
      }
      target_cents = c
    } else {
      target_cents = null
    }
    setError(null)
    const { error: upErr } = await supabase
      .from('savings_goals')
      .update({ name, target_cents })
      .eq('id', editingGoal.id)
      .eq('user_id', user.id)
    if (upErr) {
      setError(upErr.message)
      return
    }
    setEditingGoal(null)
    void load()
  }

  if (!user) return null

  const missingTableHint =
    error?.includes('savings_goals') ||
    error?.toLowerCase().includes('relation') ||
    error?.toLowerCase().includes('does not exist')

  return (
    <div className="space-y-6 pb-28">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <PiggyBank className="size-7 text-accent" strokeWidth={1.75} aria-hidden />
          Poupança
        </h1>
        <p className="text-sm text-muted">
          Caixinhas com meta opcional e movimentos manuais (o extrato geral continua separado).
        </p>
      </header>

      {missingTableHint ? (
        <Card className="border-warning/40 bg-warning/10">
          <CardContent className="py-4 text-sm">
            <p className="font-medium text-foreground">Base de dados sem tabelas de poupança</p>
            <p className="mt-1 text-muted">
              Corre a migração <code className="rounded bg-surface-elevated px-1 text-xs">supabase/migrations/20260408120000_savings.sql</code>{' '}
              no projeto Supabase (SQL Editor ou CLI) e recarrega a página.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error && !missingTableHint ? (
        <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      <div className="flex rounded-xl border border-border bg-surface-elevated/50 p-1">
        <button
          type="button"
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-xs font-medium sm:text-sm',
            tab === 'boxes' ? 'bg-accent text-[#04120c] shadow-sm' : 'text-muted',
          )}
          onClick={() => setTab('boxes')}
        >
          Caixinhas
        </button>
        <button
          type="button"
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-xs font-medium sm:text-sm',
            tab === 'ledger' ? 'bg-accent text-[#04120c] shadow-sm' : 'text-muted',
          )}
          onClick={() => setTab('ledger')}
        >
          Movimentos
        </button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted">Total em caixinhas</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted">…</p>
          ) : (
            <p
              className={cn(
                'font-mono text-2xl font-semibold tabular-nums',
                totalBalance >= 0 ? 'text-accent' : 'text-danger',
              )}
            >
              {formatBRLFromCents(totalBalance)}
            </p>
          )}
        </CardContent>
      </Card>

      {tab === 'boxes' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nova caixinha</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={addGoal} className="space-y-3">
                <div>
                  <Label>Nome</Label>
                  <Input
                    value={goalName}
                    onChange={(ev) => setGoalName(ev.target.value)}
                    placeholder="Ex.: Viagem, Reserva de emergência"
                    required
                  />
                </div>
                <div>
                  <Label>Meta opcional (R$)</Label>
                  <Input
                    inputMode="decimal"
                    value={goalTarget}
                    onChange={(ev) => setGoalTarget(ev.target.value)}
                    placeholder="Ex.: 5000,00"
                  />
                </div>
                <Button type="submit" disabled={goalSubmitting}>
                  <Plus className="size-4" />
                  Criar
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Registar movimento</CardTitle>
              <p className="text-xs text-muted">Quando guardas ou retiras dinheiro de uma caixinha.</p>
            </CardHeader>
            <CardContent>
              <form onSubmit={addEntry} className="space-y-3">
                <div>
                  <Label>Caixinha</Label>
                  <select
                    className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                    value={entryGoalId}
                    onChange={(ev) => setEntryGoalId(ev.target.value)}
                    required
                  >
                    <option value="">— Escolher —</option>
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Data</Label>
                  <Input type="date" value={entryDate} onChange={(ev) => setEntryDate(ev.target.value)} required />
                </div>
                <div className="flex gap-2 rounded-xl border border-border p-1">
                  <button
                    type="button"
                    className={cn(
                      'flex-1 rounded-lg py-2 text-xs font-medium sm:text-sm',
                      entryDirection === 'in' ? 'bg-accent text-[#04120c]' : 'text-muted',
                    )}
                    onClick={() => setEntryDirection('in')}
                  >
                    Guardei
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'flex-1 rounded-lg py-2 text-xs font-medium sm:text-sm',
                      entryDirection === 'out' ? 'bg-danger/25 text-danger' : 'text-muted',
                    )}
                    onClick={() => setEntryDirection('out')}
                  >
                    Retirei
                  </button>
                </div>
                <div>
                  <Label>Valor (R$)</Label>
                  <Input
                    inputMode="decimal"
                    value={entryAmount}
                    onChange={(ev) => setEntryAmount(ev.target.value)}
                    placeholder="0,00"
                    required
                  />
                </div>
                <div>
                  <Label>Nota (opcional)</Label>
                  <Input value={entryNote} onChange={(ev) => setEntryNote(ev.target.value)} placeholder="Ex.: 13º salário" />
                </div>
                <Button type="submit" disabled={entrySubmitting || goals.length === 0}>
                  Guardar movimento
                </Button>
              </form>
            </CardContent>
          </Card>

          {loading ? (
            <p className="text-muted">A carregar…</p>
          ) : goals.length === 0 ? (
            <p className="text-sm text-muted">Ainda não há caixinhas. Cria uma acima.</p>
          ) : (
            <ul className="space-y-3">
              {goals.map((g) => {
                const bal = balanceByGoal.get(g.id) ?? 0
                const target = g.target_cents
                const pct = target != null && target > 0 ? Math.min(100, Math.round((bal / target) * 100)) : null
                return (
                  <li key={g.id}>
                    <Card>
                      <CardContent className="space-y-3 pt-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold">{g.name}</p>
                            <p
                              className={cn(
                                'font-mono text-lg tabular-nums',
                                bal >= 0 ? 'text-accent' : 'text-danger',
                              )}
                            >
                              {formatBRLFromCents(bal)}
                            </p>
                            {target != null ? (
                              <p className="text-xs text-muted">
                                Meta {formatBRLFromCents(target)}
                                {pct != null ? ` · ${pct}%` : ''}
                              </p>
                            ) : (
                              <p className="text-xs text-muted">Sem meta numérica</p>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button type="button" variant="secondary" size="sm" onClick={() => openEdit(g)}>
                              Editar
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-danger"
                              onClick={() => void deleteGoal(g)}
                              aria-label={`Apagar ${g.name}`}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                        {target != null && target > 0 ? (
                          <div className="h-2 overflow-hidden rounded-full bg-border">
                            <div
                              className="h-full rounded-full bg-accent transition-[width]"
                              style={{ width: `${Math.min(100, Math.max(0, (bal / target) * 100))}%` }}
                            />
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {loading ? (
            <p className="text-muted">A carregar…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted">Sem movimentos registados.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((row) => {
                const g = goalById.get(row.goal_id)
                const posit = row.amount_cents >= 0
                return (
                  <li
                    key={row.id}
                    className="flex gap-2 rounded-xl border border-border/80 bg-surface-elevated/50 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{g?.name ?? 'Caixinha'}</p>
                      <p className="text-xs text-muted">
                        {format(parseISO(row.date), "d MMM yyyy", { locale: ptBR })}
                        {row.note ? ` · ${row.note}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'font-mono text-sm tabular-nums',
                          posit ? 'text-accent' : 'text-danger',
                        )}
                      >
                        {posit ? '+' : ''}
                        {formatBRLFromCents(row.amount_cents)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted hover:text-danger"
                        onClick={() => void deleteEntry(row)}
                        aria-label="Apagar movimento"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {editingGoal ? (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal
          onClick={() => setEditingGoal(null)}
        >
          <Card className="max-h-[90dvh] w-full max-w-md overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
            <CardHeader>
              <CardTitle className="text-base">Editar caixinha</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Nome</Label>
                <Input value={editName} onChange={(ev) => setEditName(ev.target.value)} />
              </div>
              <div>
                <Label>Meta (R$), vazio = sem meta</Label>
                <Input inputMode="decimal" value={editTarget} onChange={(ev) => setEditTarget(ev.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditingGoal(null)}>
                  Cancelar
                </Button>
                <Button type="button" onClick={() => void saveEdit()}>
                  Guardar
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
