import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ArrowLeft, Check, Copy, Link2, Plane, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import tripsSql from '../../supabase/migrations/20261110120000_trips.sql?raw'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents, parseMoneyToCents } from '@/lib/currency'
import { supabase } from '@/lib/supabase'
import {
  aiAvailable,
  askTripAi,
  catLabel,
  guessTripCategory,
  isMissingTable,
  loadTrips,
  matchItemCandidates,
  searchTxs,
  summarizeTrip,
  TRIP_CATEGORIES,
  type Trip,
  type TripAi,
  type TripItem,
  type TripLink,
  type TxLite,
} from '@/lib/trips'
import { cn } from '@/lib/utils'

const brl0 = (c: number) => formatBRLFromCents(c).replace(/,00$/, '')
const d2 = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`
const dateLabel = (iso: string | null) => (iso ? format(parseISO(iso), "d 'de' MMM yyyy", { locale: ptBR }) : '')
const inputCls = 'h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground'

type Data = { trips: Trip[]; items: TripItem[]; links: TripLink[]; txs: TxLite[] }

export function TripsPage() {
  const { user } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const today = format(new Date(), 'yyyy-MM-dd')
  const [data, setData] = useState<Data>({ trips: [], items: [], links: [], txs: [] })
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', destination: '', start: '', end: '', budget: '', keywords: '' })

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const r = await loadTrips(user.id)
    if (r.error) {
      if (isMissingTable(r.error)) setMissing(true)
      else setError(r.error.message)
    } else {
      setMissing(false)
      setData({ trips: r.trips, items: r.items, links: r.links, txs: r.txs })
    }
    setLoading(false)
  }, [user])
  useEffect(() => {
    void load()
  }, [load])

  const createTrip = async () => {
    if (!user || !form.name.trim()) return
    const budget = form.budget.trim() ? parseMoneyToCents(form.budget) : null
    const { data: ins, error: e } = await supabase
      .from('trips')
      .insert({
        user_id: user.id,
        name: form.name.trim(),
        destination: form.destination.trim() || null,
        start_date: form.start || null,
        end_date: form.end || null,
        budget_cents: budget && budget > 0 ? budget : null,
        keywords: form.keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      })
      .select('id')
      .single()
    if (e) return setError(e.message)
    setAdding(false)
    setForm({ name: '', destination: '', start: '', end: '', budget: '', keywords: '' })
    await load()
    navigate(`/viagens/${(ins as { id: string }).id}`)
  }

  if (missing) return <SetupTrips onDone={() => void load()} />
  const trip = id ? data.trips.find((t) => t.id === id) : null
  if (id && trip) return <TripDetail trip={trip} data={data} today={today} reload={load} />

  const active = data.trips.filter((t) => !t.archived)
  const totals = active.map((t) => ({ t, s: summarizeTrip(t, data.items, data.links, data.txs, today) }))
  const sumReal = totals.reduce((a, x) => a + x.s.realCents, 0)
  const sumNext = totals.reduce((a, x) => a + x.s.nextMonthCents, 0)

  return (
    <div className="space-y-3.5 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[30px] font-bold tracking-tight">Viagens</h1>
        <Button className="rounded-[14px]" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-4" /> Nova viagem
        </Button>
      </header>
      {error ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}

      {adding ? (
        <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
          <label className="block space-y-1 text-[13px] text-muted">
            Nome
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Intercâmbio Barcelona" />
          </label>
          <label className="block space-y-1 text-[13px] text-muted">
            Destino
            <input className={inputCls} value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="Barcelona, Espanha" />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block space-y-1 text-[13px] text-muted">
              Ida
              <input type="date" className={inputCls} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </label>
            <label className="block space-y-1 text-[13px] text-muted">
              Volta
              <input type="date" className={inputCls} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </label>
          </div>
          <label className="block space-y-1 text-[13px] text-muted">
            Orçamento total (R$)
            <input inputMode="decimal" className={inputCls} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="25.000" />
          </label>
          <label className="block space-y-1 text-[13px] text-muted">
            Palavras para achar os gastos no extrato (separe por vírgula)
            <input className={inputCls} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="latam, booking, barcelona, escola" />
          </label>
          <Button className="w-full" onClick={() => void createTrip()} disabled={!form.name.trim()}>
            Criar viagem
          </Button>
        </section>
      ) : null}

      {active.length ? (
        <section className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1 rounded-[20px] border border-border bg-surface px-4 py-3.5">
            <p className="text-xs text-muted">Gasto com viagens (pago + parcelas)</p>
            <p className="font-display text-2xl font-bold">{brl0(sumReal)}</p>
          </div>
          <div className="space-y-1 rounded-[20px] border border-border bg-surface px-4 py-3.5">
            <p className="text-xs text-muted">Parcelas no próximo mês</p>
            <p className="font-display text-2xl font-bold">{brl0(sumNext)}</p>
          </div>
        </section>
      ) : null}

      {loading ? <p className="text-sm text-muted">Carregando…</p> : null}
      {!loading && active.length === 0 && !adding ? (
        <section className="rounded-3xl border border-dashed border-border p-6 text-center text-sm text-muted">
          Nenhuma viagem ainda. Toque em <strong>Nova viagem</strong> — por exemplo o intercâmbio, o Réveillon ou a viagem de fim de semana.
        </section>
      ) : null}

      <section className="space-y-2.5">
        {totals.map(({ t, s }) => {
          const ref = t.budget_cents || s.forecastCents || 1
          return (
            <Link key={t.id} to={`/viagens/${t.id}`} className="block space-y-2.5 rounded-[22px] border border-border bg-surface p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#eef2fd] text-[#2f5bd3] dark:bg-[#1b2440] dark:text-[#8fb0ff]">
                  <Plane className="size-5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{t.name}</span>
                  <span className="block text-xs text-muted">
                    {t.start_date ? dateLabel(t.start_date) : 'sem data'}
                    {t.budget_cents ? ` · orçamento ${brl0(t.budget_cents)}` : ''}
                    {(t.travelers ?? 1) > 1 ? ` · ${t.travelers} pessoas` : ''}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-sm font-semibold tabular-nums">{brl0(s.realCents)}</span>
                  <span className="block text-[11px] text-muted">gasto</span>
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-[#eeefe9] dark:bg-[#2b2e34]">
                <div style={{ width: `${Math.min(100, (s.paidCents / ref) * 100)}%`, background: 'var(--series-1)' }} />
                <div style={{ width: `${Math.min(100, (s.committedCents / ref) * 100)}%`, background: 'var(--series-2)' }} />
              </div>
              <p className="text-xs text-muted">
                pago {brl0(s.paidCents)} · parcelas a pagar {brl0(s.committedCents)} · planejado {brl0(s.plannedCents)}
                {t.budget_cents && s.forecastCents > t.budget_cents ? ` · previsão passa do orçamento em ${brl0(s.forecastCents - t.budget_cents)}` : ''}
              </p>
            </Link>
          )
        })}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ detalhe */

function TripDetail({ trip, data, today, reload }: { trip: Trip; data: Data; today: string; reload: () => Promise<void> }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const s = useMemo(() => summarizeTrip(trip, data.items, data.links, data.txs, today), [trip, data, today])
  const links = data.links.filter((l) => l.trip_id === trip.id)
  const linkedIds = useMemo(() => new Set(links.map((l) => l.transaction_id)), [links])
  const txById = new Map(data.txs.map((t) => [t.id, t]))
  const items = data.items.filter((i) => i.trip_id === trip.id)
  const [err, setErr] = useState<string | null>(null)
  const [itemForm, setItemForm] = useState<{ description: string; category: string; amount: string; installments: string; first: string } | null>(null)
  const [suggest, setSuggest] = useState<TxLite[]>([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [ai, setAi] = useState<TripAi | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const travelers = Math.max(1, trip.travelers ?? 1)
  const [perPerson, setPerPerson] = useState(false)
  const factor = perPerson ? travelers : 1
  // valores da tela: total da viagem ou dividido por pessoa
  const brl0 = (c: number) => formatBRLFromCents(Math.round(c / factor)).replace(/,00$/, '')
  const setTravelers = async (n: number) => {
    const { error } = await supabase.from('trips').update({ travelers: n }).eq('id', trip.id)
    if (error) {
      setErr(
        /travelers/.test(error.message)
          ? 'Falta a coluna "travelers" no banco: rode o SQL de atualização que te passei no chat.'
          : error.message,
      )
      return
    }
    await reload()
  }

  const terms = useMemo(
    () => [...trip.keywords, ...(trip.destination ? trip.destination.split(/[,;]/).map((x) => x.trim()) : [])].filter(Boolean),
    [trip],
  )
  const since = useMemo(() => new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10), [])
  const runSearch = useCallback(
    async (q: string[]) => {
      if (!user) return
      setSearching(true)
      try {
        setSuggest(await searchTxs(user.id, q, linkedIds, since))
      } catch (e) {
        setErr((e as Error).message)
      } finally {
        setSearching(false)
      }
    },
    [user, linkedIds, since],
  )
  useEffect(() => {
    void runSearch(terms)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, data.links.length])

  const link = async (tx: TxLite, itemId: string | null = null) => {
    if (!user) return
    const { error } = await supabase.from('trip_transactions').upsert({ trip_id: trip.id, transaction_id: tx.id, user_id: user.id, item_id: itemId })
    if (error) return setErr(error.message)
    setSuggest((xs) => xs.filter((x) => x.id !== tx.id))
    await reload()
  }
  const unlink = async (txId: string) => {
    const { error } = await supabase.from('trip_transactions').delete().eq('trip_id', trip.id).eq('transaction_id', txId)
    if (error) return setErr(error.message)
    await reload()
  }
  const setLinkItem = async (txId: string, itemId: string | null) => {
    const { error } = await supabase.from('trip_transactions').update({ item_id: itemId }).eq('trip_id', trip.id).eq('transaction_id', txId)
    if (error) return setErr(error.message)
    await reload()
  }
  const saveItem = async () => {
    if (!user || !itemForm) return
    const cents = parseMoneyToCents(itemForm.amount)
    if (!itemForm.description.trim() || !cents || cents <= 0) return setErr('Preencha descrição e valor.')
    const { error } = await supabase.from('trip_items').insert({
      user_id: user.id,
      trip_id: trip.id,
      description: itemForm.description.trim(),
      category: itemForm.category,
      amount_cents: cents,
      installments: Math.min(48, Math.max(1, Number(itemForm.installments) || 1)),
      first_date: itemForm.first || null,
    })
    if (error) return setErr(error.message)
    setItemForm(null)
    await reload()
  }
  const deleteItem = async (id: string) => {
    const { error } = await supabase.from('trip_items').delete().eq('id', id)
    if (error) return setErr(error.message)
    await reload()
  }
  const deleteTrip = async () => {
    if (!window.confirm(`Apagar a viagem "${trip.name}"? Os lançamentos do extrato continuam lá.`)) return
    const { error } = await supabase.from('trips').delete().eq('id', trip.id)
    if (error) return setErr(error.message)
    await reload()
    navigate('/viagens')
  }
  const runAi = async () => {
    setAiBusy(true)
    setErr(null)
    try {
      setAi(await askTripAi(trip, s))
    } catch (e) {
      setErr(`IA: ${(e as Error).message}`)
    } finally {
      setAiBusy(false)
    }
  }

  const budget = trip.budget_cents ?? 0
  const ref = budget || s.forecastCents || 1
  const perDay = s.days ? Math.round(s.forecastCents / s.days) : null
  // pool para casar itens planejados: sugestões + lançamentos ainda sem item
  const unassigned = links.filter((l) => !l.item_id).map((l) => txById.get(l.transaction_id)).filter((t): t is TxLite => Boolean(t))

  return (
    <div className="space-y-3.5 pb-24">
      <header className="flex items-center gap-2">
        <Link to="/viagens" className="rounded-xl p-2 hover:bg-surface" aria-label="Voltar">
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[26px] font-bold tracking-tight">{trip.name}</h1>
          <p className="text-xs text-muted">
            {[trip.destination, trip.start_date && `${dateLabel(trip.start_date)}${trip.end_date ? ` a ${dateLabel(trip.end_date)}` : ''}`, s.days && `${s.days} dias`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button type="button" onClick={() => void deleteTrip()} className="rounded-xl p-2 text-muted hover:bg-surface" aria-label="Apagar viagem">
          <Trash2 className="size-4" />
        </button>
      </header>
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{err}</p> : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-muted">
          Pessoas
          <select
            className="h-9 rounded-lg border border-border bg-surface px-2 text-foreground"
            value={travelers}
            onChange={(e) => void setTravelers(Number(e.target.value))}
            aria-label="Quantas pessoas a viagem cobre"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {travelers > 1 ? (
          <div className="flex rounded-xl border border-border bg-surface p-0.5" role="group" aria-label="Ver valores">
            <button type="button" onClick={() => setPerPerson(false)} className={cn('rounded-lg px-3 py-1.5', !perPerson && 'bg-ink font-semibold text-[#f2f3ee]')}>
              Total ({travelers} pessoas)
            </button>
            <button type="button" onClick={() => setPerPerson(true)} className={cn('rounded-lg px-3 py-1.5', perPerson && 'bg-ink font-semibold text-[#f2f3ee]')}>
              Por pessoa
            </button>
          </div>
        ) : null}
      </div>

      <section className="space-y-3 rounded-[28px] bg-ink p-5 text-[#f2f3ee]">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[11px] text-[#b9bdb4]">Já pago</p>
            <p className="font-display text-lg font-bold tabular-nums">{brl0(s.paidCents)}</p>
          </div>
          <div>
            <p className="text-[11px] text-[#b9bdb4]">Parcelas a pagar</p>
            <p className="font-display text-lg font-bold tabular-nums">{brl0(s.committedCents)}</p>
          </div>
          <div>
            <p className="text-[11px] text-[#b9bdb4]">Previsão total</p>
            <p className="font-display text-lg font-bold tabular-nums">{brl0(s.forecastCents)}</p>
          </div>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-[#2c3036]">
          <div style={{ width: `${Math.min(100, (s.paidCents / ref) * 100)}%`, background: '#c8f169' }} />
          <div style={{ width: `${Math.min(100, (s.committedCents / ref) * 100)}%`, background: '#f2a65a' }} />
        </div>
        <p className="text-[13px] text-[#b9bdb4]">
          {budget
            ? s.forecastCents > budget
              ? `A previsão passa do orçamento (${brl0(budget)}) em ${brl0(s.forecastCents - budget)}.`
              : `Dentro do orçamento de ${brl0(budget)}: sobram ${brl0(budget - s.forecastCents)}.`
            : 'Sem orçamento definido.'}
          {s.nextMonthCents ? ` Próximo mês: ${brl0(s.nextMonthCents)} em parcelas desta viagem.` : ''}
          {perDay ? ` ≈ ${brl0(perDay)} por dia de viagem.` : ''}
        </p>
      </section>

      {s.byCategory.length ? (
        <section className="space-y-2 rounded-3xl border border-border bg-surface p-[18px]">
          <h2 className="text-base font-semibold">Por categoria</h2>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-sm">
            <span className="text-xs text-muted">Categoria</span>
            <span className="text-right text-xs text-muted">Planejado</span>
            <span className="text-right text-xs text-muted">Real</span>
            {s.byCategory.map((r) => (
              <FragmentRow key={r.key} label={r.label} planned={r.plannedCents} real={r.realCents} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-2 rounded-3xl border border-border bg-surface p-[18px]">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Planejado</h2>
          <Button size="sm" variant="secondary" onClick={() => setItemForm(itemForm ? null : { description: '', category: 'passagem', amount: '', installments: '1', first: '' })}>
            <Plus className="size-4" /> Gasto planejado
          </Button>
        </div>
        {itemForm ? (
          <div className="space-y-2 rounded-2xl bg-background p-3">
            <input className={inputCls} placeholder="Ex.: Passagem LATAM ida e volta" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value, category: itemForm.description ? itemForm.category : guessTripCategory(e.target.value) })} />
            <div className="grid grid-cols-2 gap-2">
              <select className={inputCls} value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}>
                {TRIP_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input inputMode="decimal" className={inputCls} placeholder="Valor total R$" value={itemForm.amount} onChange={(e) => setItemForm({ ...itemForm, amount: e.target.value })} />
              <label className="space-y-1 text-xs text-muted">
                Parcelas
                <input inputMode="numeric" className={inputCls} value={itemForm.installments} onChange={(e) => setItemForm({ ...itemForm, installments: e.target.value.replace(/\D/g, '') })} />
              </label>
              <label className="space-y-1 text-xs text-muted">
                1ª parcela / data
                <input type="date" className={inputCls} value={itemForm.first} onChange={(e) => setItemForm({ ...itemForm, first: e.target.value })} />
              </label>
            </div>
            <Button className="w-full" onClick={() => void saveItem()}>
              Salvar
            </Button>
          </div>
        ) : null}
        {s.items.length === 0 && !itemForm ? <p className="text-sm text-muted">Lance o que você planeja gastar: passagem, hospedagem, curso, seguro…</p> : null}
        <ul className="space-y-2">
          {s.items.map(({ item, realCents, matchedCount, status }) => {
            const cands = status === 'sem_lancamento' || status === 'pelo_plano' ? matchItemCandidates(item, [...unassigned, ...suggest]).slice(0, 3) : []
            return (
              <li key={item.id} className="space-y-1.5 rounded-2xl border border-[#eeefe9] p-3 dark:border-[#2b2e34]">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.description}</p>
                    <p className="text-xs text-muted">
                      {catLabel(item.category)} · {brl0(item.amount_cents)}
                      {item.installments > 1 ? ` em ${item.installments}x de ${brl0(Math.round(item.amount_cents / item.installments))}` : ''}
                      {item.first_date ? ` · ${d2(item.first_date)}` : ''}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      status === 'ok' && 'bg-[#eef7d8] text-[#3f5a12] dark:bg-[#2a3317] dark:text-[#c8f169]',
                      status === 'parcial' && 'bg-[#eef2fd] text-[#2f5bd3] dark:bg-[#1b2440] dark:text-[#8fb0ff]',
                      status === 'acima' && 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]',
                      status === 'sem_lancamento' && 'bg-background text-muted',
                      status === 'pelo_plano' && 'bg-[#eef2fd] text-[#2f5bd3] dark:bg-[#1b2440] dark:text-[#8fb0ff]',
                    )}
                  >
                    {status === 'pelo_plano'
                      ? item.installments > 1
                        ? `${s.items.find((x) => x.item.id === item.id)?.planPaid ?? 0}/${item.installments} pagas`
                        : (s.items.find((x) => x.item.id === item.id)?.planPaid ?? 0) > 0
                          ? 'pago'
                          : 'a pagar'
                      : status === 'ok' ? 'bate' : status === 'parcial' ? `${brl0(realCents)} de ${brl0(item.amount_cents)}` : status === 'acima' ? `${brl0(realCents - item.amount_cents)} acima` : 'sem lançamento'}
                  </span>
                  <button type="button" onClick={() => void deleteItem(item.id)} className="shrink-0 rounded-md p-1 text-muted hover:bg-background" aria-label="Apagar item">
                    <X className="size-4" />
                  </button>
                </div>
                {matchedCount ? <p className="text-[11px] text-muted">{matchedCount} lançamento(s) ligado(s) a este item (parcelas futuras contadas).</p> : null}
                {status === 'pelo_plano' ? (
                  <p className="text-[11px] text-muted">Pelo calendário do plano. Ligue a parcela do cartão (abaixo) para conferir com o extrato.</p>
                ) : null}
                {cands.length ? (
                  <div className="space-y-1">
                    <p className="text-[11px] text-muted">Parece com:</p>
                    {cands.map((t) => (
                      <button key={t.id} type="button" onClick={() => void link(t, item.id)} className="flex w-full items-center gap-2 rounded-lg bg-background px-2 py-1.5 text-left text-xs">
                        <Link2 className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {d2(t.date)} · {t.description_raw}
                        </span>
                        <span className="shrink-0 tabular-nums">{brl0(t.amount_cents)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="space-y-2 rounded-3xl border border-border bg-surface p-[18px]">
        <h2 className="text-base font-semibold">Lançamentos desta viagem</h2>
        {links.length === 0 ? <p className="text-sm text-muted">Nenhum ainda. Adicione abaixo a partir do seu extrato e das faturas.</p> : null}
        <ul className="space-y-1.5">
          {links.map((l) => {
            const t = txById.get(l.transaction_id)
            if (!t) return null
            return (
              <li key={l.transaction_id} className="flex flex-wrap items-center gap-2 border-t border-[#eeefe9] pt-1.5 text-sm first:border-0 first:pt-0 dark:border-[#2b2e34]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.description_raw}</span>
                  <span className="block text-xs text-muted">
                    {d2(t.date)}
                    {t.account ? ` · ${t.account}` : ''}
                  </span>
                </span>
                <select className="h-8 max-w-[45%] rounded-lg border border-border bg-background px-1.5 text-xs" value={l.item_id ?? ''} onChange={(e) => void setLinkItem(t.id, e.target.value || null)} aria-label="Item planejado">
                  <option value="">{catLabel(guessTripCategory(t.description_raw))} (sem item)</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.description}
                    </option>
                  ))}
                </select>
                <span className={cn('shrink-0 font-semibold tabular-nums', t.kind === 'credit' && 'text-positive')}>
                  {t.kind === 'credit' ? '+' : '−'}
                  {brl0(t.amount_cents)}
                </span>
                <button type="button" onClick={() => void unlink(t.id)} className="shrink-0 rounded-md p-1 text-muted hover:bg-background" aria-label="Tirar da viagem">
                  <X className="size-4" />
                </button>
              </li>
            )
          })}
        </ul>
        {s.installments.length ? (
          <div className="rounded-2xl bg-background p-3 text-xs">
            <p className="mb-1 font-semibold">Parcelas</p>
            {s.installments.map((i) => (
              <p key={`${i.name}${i.total}`} className="flex justify-between gap-2">
                <span className="truncate">
                  {i.name} · {i.paid}/{i.total} pagas
                </span>
                <span className="shrink-0 tabular-nums">
                  {brl0(i.perMonthCents)}/mês até {format(parseISO(`${i.lastMonth}-01`), "LLL'/'yy", { locale: ptBR })}
                </span>
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-2 rounded-3xl border border-border bg-surface p-[18px]">
        <h2 className="text-base font-semibold">Adicionar do extrato</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query.trim() ? [query.trim()] : terms)
          }}
        >
          <input className={inputCls} placeholder="Buscar: latam, booking, decathlon…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" className="h-11">
            Buscar
          </Button>
        </form>
        <p className="text-xs text-muted">
          {query.trim() ? `Resultado de “${query.trim()}”` : terms.length ? `Parecem desta viagem (${terms.slice(0, 5).join(', ')}):` : 'Digite algo para buscar no extrato e nas faturas.'}
          {searching ? ' procurando…' : ''}
        </p>
        <ul className="space-y-1">
          {suggest.slice(0, 30).map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => void link(t)} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-background">
                <Plus className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.description_raw}</span>
                  <span className="block text-xs text-muted">
                    {d2(t.date)}
                    {t.account ? ` · ${t.account}` : ''} · {catLabel(guessTripCategory(t.description_raw))}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{brl0(t.amount_cents)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Previsão e sugestões com IA</h2>
          <Button size="sm" onClick={() => void runAi()} disabled={aiBusy || !aiAvailable()}>
            <Sparkles className="size-4" /> {aiBusy ? 'Pensando…' : ai ? 'Refazer' : 'Simular'}
          </Button>
        </div>
        {!aiAvailable() ? (
          <p className="text-xs text-muted">A IA não está configurada neste app (chave Gemini/Groq no build). A previsão acima continua funcionando sem ela.</p>
        ) : !ai ? (
          <p className="text-xs text-muted">Estima o custo total realista no destino (inclusive o que falta planejar, como alimentação diária e transporte) e sugere onde economizar. Só envia os totais por categoria, sem nomes ou contas.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              Previsão da IA: <strong>{brl0(Math.round(ai.previsao_total_reais * 100))}</strong>
              {budget ? ` (orçamento ${brl0(budget)})` : ''}
            </p>
            <ul className="space-y-1 text-xs">
              {ai.por_categoria.map((c) => (
                <li key={c.categoria} className="flex justify-between gap-2">
                  <span className="min-w-0">
                    <strong>{c.categoria}</strong> — {c.comentario}
                  </span>
                  <span className="shrink-0 tabular-nums">{brl0(Math.round(c.estimativa_reais * 100))}</span>
                </li>
              ))}
            </ul>
            {ai.sugestoes.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {ai.sugestoes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : null}
            {ai.alertas.length ? (
              <ul className="space-y-0.5 text-xs text-[#9a3412] dark:text-[#ffb38a]">
                {ai.alertas.map((x) => (
                  <li key={x}>⚠ {x}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted">Estimativa automática: confira preços antes de decidir.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function FragmentRow({ label, planned, real }: { label: string; planned: number; real: number }) {
  return (
    <>
      <span className="truncate">{label}</span>
      <span className="text-right tabular-nums text-muted">{planned ? brl0(planned) : '—'}</span>
      <span className={cn('text-right font-semibold tabular-nums', planned && real > planned && 'text-[#9a3412] dark:text-[#ffb38a]')}>{real ? brl0(real) : '—'}</span>
    </>
  )
}

/* ------------------------------------------------------------------ setup */

function SetupTrips({ onDone }: { onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const [checked, setChecked] = useState(0)
  // projeto Supabase do app (https://<ref>.supabase.co) → link direto para o SQL Editor
  const ref = (import.meta.env.VITE_SUPABASE_URL ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
  const sqlUrl = ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard'
  return (
    <div className="space-y-3.5 pb-24">
      <h1 className="text-[30px] font-bold tracking-tight">Viagens</h1>
      <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px] text-sm">
        <p className="font-semibold">Falta criar as tabelas de viagens no seu banco (uma vez só).</p>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>Toque em <strong>Copiar SQL</strong>.</li>
          <li>
            Abra o{' '}
            <a href={sqlUrl} target="_blank" rel="noreferrer" className="font-semibold text-foreground underline">
              SQL Editor do Supabase
            </a>{' '}
            (entre com a sua conta), cole tudo e toque em <strong>Run</strong>. Deve aparecer “Success. No rows returned”.
          </li>
          <li>Volte aqui e toque em “Já rodei”.</li>
        </ol>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(tripsSql).then(() => setCopied(true))
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copiado' : 'Copiar SQL'}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setChecked((n) => n + 1)
              onDone()
            }}
          >
            Já rodei
          </Button>
        </div>
        {checked ? (
          <p className="rounded-xl bg-[#fff4ec] p-2.5 text-xs text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]">
            Ainda não encontrei as tabelas. Confira se o Run terminou com “Success” (se deu erro, me mande o print do erro). Se deu certo, espere 1 minuto e toque em “Já rodei” de novo.
          </p>
        ) : null}
        <pre className="max-h-64 overflow-auto rounded-xl bg-background p-3 text-[11px] leading-snug">{tripsSql}</pre>
      </section>
    </div>
  )
}
