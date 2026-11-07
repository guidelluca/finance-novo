import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { CreditCard as CardIcon, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import {
  billHistory,
  currentOpenBill,
  daysUntil,
  nextBill,
  sumBillCents,
} from '@/lib/creditCards'
import { formatBRLFromCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import type { Category, CreditCard, Transaction } from '@/types/database'
import { cn } from '@/lib/utils'

type TxWithCat = Transaction & { categories: Pick<Category, 'name'> | null }

interface CardForm {
  name: string
  last4: string
  brand: string
  limitBrl: string
  closingDay: string
  dueDay: string
  color: string
}

const EMPTY_FORM: CardForm = {
  name: '',
  last4: '',
  brand: '',
  limitBrl: '',
  closingDay: '1',
  dueDay: '10',
  color: '#6366f1',
}

function parseBrToCents(raw: string): number | null {
  const s = raw.replace(/\./g, '').replace(',', '.').trim()
  if (!s) return null
  const num = Number(s)
  if (Number.isNaN(num)) return null
  return Math.round(Math.abs(num) * 100)
}

function centsToBr(cents: number | null | undefined): string {
  if (cents == null) return ''
  return (cents / 100).toFixed(2).replace('.', ',')
}

export function CardsPage() {
  const { user } = useAuth()
  const [cards, setCards] = useState<CreditCard[]>([])
  const [txs, setTxs] = useState<TxWithCat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CardForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [openCycleKey, setOpenCycleKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    const [{ data: c, error: ce }, { data: t }] = await Promise.all([
      supabase
        .from('credit_cards')
        .select('*')
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('sort_order')
        .order('name'),
      supabase
        .from('transactions')
        .select('*, categories(name)')
        .eq('user_id', user.id)
        .not('credit_card_id', 'is', null)
        .order('date', { ascending: false })
        .limit(2000),
    ])
    if (ce) setError(ce.message)
    setCards((c as CreditCard[]) ?? [])
    setTxs((t as TxWithCat[]) ?? [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const openForm = (card?: CreditCard) => {
    setFormError(null)
    if (card) {
      setEditingId(card.id)
      setForm({
        name: card.name,
        last4: card.last4 ?? '',
        brand: card.brand ?? '',
        limitBrl: centsToBr(card.limit_cents ?? null),
        closingDay: String(card.closing_day),
        dueDay: String(card.due_day),
        color: card.color ?? '#6366f1',
      })
    } else {
      setEditingId(null)
      setForm(EMPTY_FORM)
    }
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const saveCard = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    setFormError(null)
    const name = form.name.trim()
    if (!name) {
      setFormError('Dá um nome ao cartão (ex.: Nubank Ultravioleta).')
      return
    }
    const closingDay = Number(form.closingDay)
    const dueDay = Number(form.dueDay)
    if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
      setFormError('Dia de fechamento entre 1 e 31.')
      return
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      setFormError('Dia de vencimento entre 1 e 31.')
      return
    }
    const limitCents = form.limitBrl.trim() ? parseBrToCents(form.limitBrl) : null
    const last4 = form.last4.trim().replace(/\D/g, '').slice(-4) || null

    setSubmitting(true)
    try {
      if (editingId) {
        const { error } = await supabase
          .from('credit_cards')
          .update({
            name,
            last4,
            brand: form.brand.trim() || null,
            limit_cents: limitCents,
            closing_day: closingDay,
            due_day: dueDay,
            color: form.color || null,
          })
          .eq('id', editingId)
          .eq('user_id', user.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('credit_cards').insert({
          user_id: user.id,
          name,
          last4,
          brand: form.brand.trim() || null,
          limit_cents: limitCents,
          closing_day: closingDay,
          due_day: dueDay,
          color: form.color || null,
        })
        if (error) throw error
      }
      closeForm()
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao guardar cartão.')
    } finally {
      setSubmitting(false)
    }
  }

  const deleteCard = async (card: CreditCard) => {
    if (!user) return
    if (
      !window.confirm(
        `Apagar o cartão "${card.name}"? Os lançamentos vinculados NÃO são apagados — só perdem o vínculo com este cartão.`,
      )
    )
      return
    const { error } = await supabase.from('credit_cards').delete().eq('id', card.id).eq('user_id', user.id)
    if (error) {
      setError(error.message)
      return
    }
    void load()
  }

  if (!user) return null

  return (
    <div className="space-y-6 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cartões</h1>
          <p className="text-sm text-muted">Faturas, limites e ciclo mensal</p>
        </div>
        <Button type="button" size="sm" onClick={() => openForm()}>
          <Plus className="size-4" />
          Novo cartão
        </Button>
      </header>

      {error ? (
        <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editingId ? 'Editar cartão' : 'Novo cartão'}
            </CardTitle>
            <CardDescription>
              Define fechamento e vencimento para calcular a fatura corretamente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveCard} className="space-y-3">
              <div>
                <Label>Nome</Label>
                <Input
                  placeholder="Nubank Ultravioleta"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Bandeira</Label>
                  <Input
                    placeholder="Mastercard / Visa…"
                    value={form.brand}
                    onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Final (4 dígitos)</Label>
                  <Input
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="1234"
                    value={form.last4}
                    onChange={(e) => setForm((f) => ({ ...f, last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Fecha dia</Label>
                  <Input
                    inputMode="numeric"
                    maxLength={2}
                    value={form.closingDay}
                    onChange={(e) => setForm((f) => ({ ...f, closingDay: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                    required
                  />
                </div>
                <div>
                  <Label>Vence dia</Label>
                  <Input
                    inputMode="numeric"
                    maxLength={2}
                    value={form.dueDay}
                    onChange={(e) => setForm((f) => ({ ...f, dueDay: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Limite (R$)</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="Ex.: 2500,00"
                    value={form.limitBrl}
                    onChange={(e) => setForm((f) => ({ ...f, limitBrl: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Cor</Label>
                  <input
                    type="color"
                    value={form.color}
                    onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                    className="mt-1 h-11 w-full cursor-pointer rounded-xl border border-border bg-surface"
                    aria-label="Cor do cartão"
                  />
                </div>
              </div>
              {formError ? <p className="text-sm text-danger">{formError}</p> : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'A guardar…' : 'Guardar'}
                </Button>
                <Button type="button" variant="secondary" onClick={closeForm}>
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <p className="text-muted">A carregar…</p>
      ) : cards.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <CardIcon className="mx-auto mb-2 size-8 text-muted" aria-hidden />
            <p className="text-sm text-muted">Ainda não cadastraste cartões.</p>
            <Button type="button" size="sm" className="mt-3" onClick={() => openForm()}>
              <Plus className="size-4" />
              Adicionar o primeiro
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {cards.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              txs={txs}
              open={openCardId === card.id}
              onToggle={() => {
                if (openCardId === card.id) {
                  setOpenCardId(null)
                  setOpenCycleKey(null)
                } else {
                  setOpenCardId(card.id)
                  setOpenCycleKey(null)
                }
              }}
              openCycleKey={openCycleKey}
              setOpenCycleKey={setOpenCycleKey}
              onEdit={() => openForm(card)}
              onDelete={() => void deleteCard(card)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface CardRowProps {
  card: CreditCard
  txs: TxWithCat[]
  open: boolean
  onToggle: () => void
  openCycleKey: string | null
  setOpenCycleKey: (k: string | null) => void
  onEdit: () => void
  onDelete: () => void
}

function CardRow({ card, txs, open, onToggle, openCycleKey, setOpenCycleKey, onEdit, onDelete }: CardRowProps) {
  const current = useMemo(() => currentOpenBill(card), [card])
  const upcoming = useMemo(() => nextBill(card), [card])
  const history = useMemo(() => billHistory(card, 6), [card])

  const currentTotal = sumBillCents(txs, current)
  const upcomingTotal = sumBillCents(txs, upcoming)

  const pctOfLimit =
    card.limit_cents && card.limit_cents > 0
      ? Math.min(100, Math.round((currentTotal / card.limit_cents) * 100))
      : null

  const color = card.color || '#6366f1'

  const activeCycle = openCycleKey
    ? history.find((c) => c.key === openCycleKey) ?? current
    : current
  const cycleTxs = txs
    .filter((t) => t.credit_card_id === card.id)
    .filter((t) => {
      const d = t.date
      return d >= activeCycle.startIso && d <= activeCycle.closingIso
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const activeCycleTotal = sumBillCents(txs, activeCycle)

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface-elevated/70">
      <button
        type="button"
        onClick={onToggle}
        className="block w-full text-left"
        aria-expanded={open}
      >
        <div
          className="relative px-4 py-4 text-white"
          style={{
            background: `linear-gradient(135deg, ${color} 0%, ${darken(color)} 100%)`,
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm/tight font-semibold">{card.name}</p>
              <p className="text-[11px] opacity-80">
                {card.brand ? `${card.brand} · ` : ''}
                {card.last4 ? `final ${card.last4}` : 'sem final'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide opacity-70">Fatura atual</p>
              <p className="text-lg font-semibold tabular-nums">{formatBRLFromCents(currentTotal)}</p>
            </div>
          </div>

          {pctOfLimit != null ? (
            <div className="mt-3 space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
                <div
                  className="h-full rounded-full bg-white"
                  style={{ width: `${pctOfLimit}%` }}
                  aria-label={`Uso do limite ${pctOfLimit}%`}
                />
              </div>
              <p className="text-[10px] opacity-80">
                {pctOfLimit}% do limite ({formatBRLFromCents(card.limit_cents!)})
              </p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="opacity-90">
              Fecha {formatIsoBr(current.closingIso)} · em {daysUntil(current.closingIso)}d
            </span>
            <span className="opacity-90">Vence {formatIsoBr(current.dueIso)}</span>
          </div>
        </div>
      </button>

      {open ? (
        <div className="border-t border-border bg-surface p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-muted">Próxima fatura ({upcoming.label})</p>
              <p className="text-sm font-semibold tabular-nums">
                {formatBRLFromCents(upcomingTotal)}
              </p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="secondary" size="sm" onClick={onEdit}>
                <Pencil className="size-3.5" />
                Editar
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="text-danger hover:text-danger"
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
                Apagar
              </Button>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap gap-1">
            {history.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setOpenCycleKey(c.key === current.key ? null : c.key)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] transition',
                  activeCycle.key === c.key
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:border-accent/40',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>

          <p className="mb-2 text-xs text-muted">
            {activeCycle.label} · {formatIsoBr(activeCycle.startIso)} a{' '}
            {formatIsoBr(activeCycle.closingIso)} · Total{' '}
            <strong className="tabular-nums text-foreground">{formatBRLFromCents(activeCycleTotal)}</strong>
          </p>

          {cycleTxs.length === 0 ? (
            <p className="rounded-xl border border-border/60 bg-surface-elevated p-3 text-center text-xs text-muted">
              Sem lançamentos neste ciclo.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {cycleTxs.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface-elevated/60 px-2.5 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{t.description_raw}</p>
                    <p className="text-[10px] text-muted">
                      {format(parseISO(t.date), 'dd MMM', { locale: ptBR })}
                      {t.categories?.name ? ` · ${t.categories.name}` : ''}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'font-mono text-sm tabular-nums',
                      t.kind === 'credit' ? 'text-emerald-400' : 'text-red-300',
                    )}
                  >
                    {t.kind === 'credit' ? '+' : '−'}
                    {formatBRLFromCents(t.amount_cents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

function formatIsoBr(iso: string): string {
  try {
    return format(parseISO(iso), "d MMM", { locale: ptBR })
  } catch {
    return iso
  }
}

/** Escurece uma cor hex simples para gradiente. */
function darken(hex: string): string {
  const c = hex.replace('#', '')
  if (c.length !== 6) return hex
  const r = Math.max(0, parseInt(c.slice(0, 2), 16) - 40)
  const g = Math.max(0, parseInt(c.slice(2, 4), 16) - 40)
  const b = Math.max(0, parseInt(c.slice(4, 6), 16) - 40)
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}
