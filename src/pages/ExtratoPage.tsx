import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { AlertCircle, ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useMonthData } from '@/hooks/useMonthData'
import { parseBRLToCents } from '@/lib/budgets'
import { formatBRLFromCents } from '@/lib/currency'
import { normalizeTransactionLogicalDescription, transactionDedupCandidates } from '@/lib/dedupKey'
import { learnRules } from '@/lib/learnRules'
import { identifyMerchant, pickCategoryId } from '@/lib/merchantIdentify'
import { issueId, shiftMonth, type ExcludedReason } from '@/lib/monthConsolidation'
import { suggestCategoryId } from '@/lib/rulesEngine'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { tileColors } from '@/pages/HomePage'
import type { Category, Rule, Transaction } from '@/types/database'

type Chip = 'all' | 'out' | 'in' | 'none' | 'dup'
type Form = { date: string; description: string; amount: string; kind: 'debit' | 'credit'; categoryId: string; account: string }

const EXCLUDED_LABEL: Record<ExcludedReason, string> = {
  duplicada: 'repetida? — só conta se você confirmar',
  pagamento_fatura: 'pagamento de fatura — não conta',
  transferencia_interna: 'entre suas contas — não conta',
  investimento: 'aplicação — não conta',
  estorno: 'estornado — não conta',
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function dayLabel(iso: string, today: string): string {
  if (iso === today) return 'Hoje'
  const diff = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 86_400_000
  if (diff === 1) return 'Ontem'
  const s = format(parseISO(iso), "EEE, d MMM", { locale: ptBR })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function ExtratoPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const today = format(new Date(), 'yyyy-MM-dd')
  const [month, setMonth] = useState(() => params.get('month') ?? today.slice(0, 7))
  const [chip, setChip] = useState<Chip>(() => {
    const k = params.get('kind')
    if (params.get('filtro') === 'dup') return 'dup'
    return k === 'credit' ? 'in' : k === 'debit' ? 'out' : params.get('category') === 'none' ? 'none' : 'all'
  })
  const [q, setQ] = useState(() => {
    const c = params.get('category')
    return c && c !== 'none' ? c : ''
  })
  const [txs, setTxs] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Form | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [adding, setAdding] = useState(() => params.get('new') === '1')
  const [newForm, setNewForm] = useState<Form>({ date: today, description: '', amount: '', kind: 'debit', categoryId: '', account: '' })
  const [learn, setLearn] = useState(true)
  const [busy, setBusy] = useState(false)

  const cons = useMonthData(month)
  const excludedById = useMemo(() => new Map(cons.result.excluded.map((e) => [e.tx.id, e])), [cons.result])

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const from = `${month}-01`
    const to = `${shiftMonth(month, 1)}-01`
    const [t, c, r] = await Promise.all([
      supabase.from('transactions').select('*').eq('user_id', user.id).gte('date', from).lt('date', to).order('date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('categories').select('*').eq('user_id', user.id).order('sort_order'),
      supabase.from('rules').select('*').eq('user_id', user.id).eq('enabled', true),
    ])
    if (t.error) setError(t.error.message)
    setTxs((t.data ?? []) as Transaction[])
    setCategories((c.data ?? []) as Category[])
    setRules((r.data ?? []) as Rule[])
    setLoading(false)
  }, [user, month])

  const consReload = cons.reload
  const reloadAll = useCallback(() => {
    void load()
    void consReload()
  }, [load, consReload])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (params.get('new') === '1') {
      params.delete('new')
      setParams(params, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])
  const merchantOf = useCallback((t: Transaction) => identifyMerchant(t.description_raw).name, [])

  // totais sem repetição: pagamento de fatura, transferências entre contas e duplicadas não contam
  const counts = (t: Transaction) => !excludedById.has(t.id)
  const consReady = !cons.loading && !cons.error
  const income = consReady
    ? cons.result.totals.incomeCents
    : txs.filter((t) => t.kind === 'credit').reduce((s, t) => s + t.amount_cents, 0)
  const expense = consReady
    ? cons.result.totals.expenseCents
    : txs.filter((t) => t.kind === 'debit').reduce((s, t) => s + t.amount_cents, 0)
  const uncategorized = txs.filter((t) => !t.category_id && t.kind === 'debit' && counts(t))

  const filtered = useMemo(() => {
    const nq = norm(q.trim())
    return txs.filter((t) => {
      if (chip === 'out' && t.kind !== 'debit') return false
      if (chip === 'in' && t.kind !== 'credit') return false
      if (chip === 'none' && (t.category_id || t.kind !== 'debit' || !counts(t))) return false
      if (chip === 'dup' && excludedById.get(t.id)?.reason !== 'duplicada') return false
      if (!nq) return true
      const hay = norm(`${merchantOf(t)} ${t.description_raw} ${catName.get(t.category_id ?? '') ?? ''} ${t.account ?? ''} ${(t.amount_cents / 100).toFixed(2).replace('.', ',')}`)
      return hay.includes(nq)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs, chip, q, catName, merchantOf, excludedById])

  const days = useMemo(() => {
    const m = new Map<string, Transaction[]>()
    for (const t of filtered) m.set(t.date, [...(m.get(t.date) ?? []), t])
    return [...m.entries()]
  }, [filtered])

  const suggestFor = (t: Transaction): string | null =>
    suggestCategoryId(t.description_raw, rules) ?? pickCategoryId(identifyMerchant(t.description_raw).categories, categories)

  const setCategory = async (t: Transaction, categoryId: string | null, withRule: boolean) => {
    const { error: e } = await supabase.from('transactions').update({ category_id: categoryId }).eq('id', t.id)
    if (e) {
      setError(e.message)
      return
    }
    setTxs((list) => list.map((x) => (x.id === t.id ? { ...x, category_id: categoryId } : x)))
    if (categoryId && withRule && user) {
      const key = identifyMerchant(t.description_raw).ruleKey
      const n = await learnRules(user.id, [{ key, categoryId }])
      setNotice(n > 0 ? `Categoria salva. Aprendi: “${key}” → ${catName.get(categoryId)}.` : 'Categoria salva.')
      if (n > 0) {
        const { data } = await supabase.from('rules').select('*').eq('user_id', user.id).eq('enabled', true)
        setRules((data ?? []) as Rule[])
      }
    }
  }

  const openRow = (t: Transaction) => {
    if (openId === t.id) {
      setOpenId(null)
      return
    }
    setOpenId(t.id)
    setConfirmDel(false)
    setEdit({
      date: t.date,
      description: t.description_raw,
      amount: (t.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
      kind: t.kind,
      categoryId: t.category_id ?? '',
      account: t.account ?? '',
    })
  }

  const saveEdit = async (t: Transaction) => {
    if (!edit) return
    const cents = parseBRLToCents(edit.amount)
    if (!cents) {
      setError('Valor inválido.')
      return
    }
    setBusy(true)
    const changedDesc = edit.description !== t.description_raw
    const { error: e } = await supabase
      .from('transactions')
      .update({
        date: edit.date,
        amount_cents: cents,
        kind: edit.kind,
        description_raw: edit.description,
        ...(changedDesc ? { description_normalized: edit.description.toLowerCase() } : {}),
        category_id: edit.categoryId || null,
        account: edit.account || null,
      })
      .eq('id', t.id)
    setBusy(false)
    if (e) {
      setError(/duplicate|unique/i.test(e.message) ? 'Já existe um lançamento igual (mesma data, valor e descrição).' : e.message)
      return
    }
    if (edit.categoryId && edit.categoryId !== t.category_id && learn && user) {
      await learnRules(user.id, [{ key: identifyMerchant(edit.description).ruleKey, categoryId: edit.categoryId }])
    }
    setOpenId(null)
    setNotice('Lançamento atualizado.')
    reloadAll()
  }

  /** "Não é repetida": passa a contar (mesma marcação do Mês consolidado). */
  const confirmNotDuplicate = (t: Transaction, keepId: string) => {
    if (!user) return
    const key = `finance:dismissed:${user.id}`
    try {
      const cur = new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
      cur.add(issueId('duplicada', [keepId, t.id]))
      localStorage.setItem(key, JSON.stringify([...cur]))
    } catch {
      setError('Não consegui guardar a confirmação neste navegador.')
      return
    }
    setOpenId(null)
    setNotice(`${merchantOf(t)} agora conta nos totais.`)
    void consReload()
  }

  const remove = async (t: Transaction) => {
    const { error: e } = await supabase.from('transactions').delete().eq('id', t.id)
    if (e) setError(e.message)
    else {
      setTxs((l) => l.filter((x) => x.id !== t.id))
      setOpenId(null)
      void consReload()
      setNotice('Lançamento apagado.')
    }
  }

  const addNew = async () => {
    if (!user) return
    const cents = parseBRLToCents(newForm.amount)
    if (!cents || !newForm.description.trim()) {
      setError('Preencha descrição e valor.')
      return
    }
    setBusy(true)
    setError(null)
    const desc = newForm.description.trim()
    const normStored = desc.toLowerCase()
    const logical = normalizeTransactionLogicalDescription(normStored, desc)
    const { data: same } = await supabase
      .from('transactions')
      .select('description_normalized, description_raw')
      .eq('user_id', user.id)
      .eq('date', newForm.date)
      .eq('amount_cents', cents)
      .eq('kind', newForm.kind)
    if (same?.some((r) => normalizeTransactionLogicalDescription(r.description_normalized, r.description_raw) === logical)) {
      setBusy(false)
      setError('Este lançamento já existe (mesma data, valor, tipo e descrição).')
      return
    }
    const [dedup_key] = await transactionDedupCandidates(user.id, newForm.date, cents, newForm.kind, desc, null)
    const autoCat = suggestCategoryId(desc, rules) ?? pickCategoryId(identifyMerchant(desc).categories, categories)
    const { error: e } = await supabase.from('transactions').insert({
      user_id: user.id,
      date: newForm.date,
      amount_cents: cents,
      description_raw: desc,
      description_normalized: normStored,
      kind: newForm.kind,
      category_id: newForm.categoryId || autoCat || null,
      account: newForm.account.trim() || null,
      dedup_key: dedup_key!,
    })
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    setNotice(`Adicionado: ${identifyMerchant(desc).name}.`)
    setAdding(false)
    setNewForm({ date: today, description: '', amount: '', kind: 'debit', categoryId: '', account: '' })
    if (!newForm.date.startsWith(month)) setMonth(newForm.date.slice(0, 7))
    else reloadAll()
  }

  const dupCount = cons.result.excluded.filter((e) => e.reason === 'duplicada').length
  const pending = uncategorized[0]
  const pendingSuggestion = pending ? suggestFor(pending) : null
  const monthLabel = format(parseISO(`${month}-01`), "LLLL 'de' yyyy", { locale: ptBR })

  const chips: { id: Chip; label: string }[] = [
    { id: 'all', label: 'Tudo' },
    { id: 'out', label: 'Saídas' },
    { id: 'in', label: 'Entradas' },
    { id: 'none', label: `Sem categoria${uncategorized.length ? ` · ${uncategorized.length}` : ''}` },
    ...(dupCount > 0 || chip === 'dup' ? [{ id: 'dup' as const, label: `Repetidas? · ${dupCount}` }] : []),
  ]

  const formFields = (f: Form, set: (f: Form) => void) => (
    <div className="space-y-2.5">
      <input value={f.description} onChange={(e) => set({ ...f, description: e.target.value })} placeholder="Descrição (ex.: Padaria Real)" aria-label="Descrição" className="h-11 w-full rounded-xl border border-border bg-background px-3" />
      <div className="grid grid-cols-2 gap-2.5">
        <input inputMode="decimal" value={f.amount} onChange={(e) => set({ ...f, amount: e.target.value })} placeholder="Valor (R$)" aria-label="Valor" className="h-11 rounded-xl border border-border bg-background px-3 text-right tabular-nums" />
        <input type="date" value={f.date} onChange={(e) => set({ ...f, date: e.target.value })} aria-label="Data" className="h-11 rounded-xl border border-border bg-background px-3" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-background p-1 text-sm" role="radiogroup" aria-label="Tipo">
          {(['debit', 'credit'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} onClick={() => set({ ...f, kind: k })} className={cn('rounded-lg py-1.5 font-semibold', f.kind === k ? 'bg-surface shadow-sm' : 'text-muted')}>
              {k === 'debit' ? 'Saída' : 'Entrada'}
            </button>
          ))}
        </div>
        <input value={f.account} onChange={(e) => set({ ...f, account: e.target.value })} placeholder="Conta (opcional)" aria-label="Conta" className="h-11 rounded-xl border border-border bg-background px-3" />
      </div>
      <select value={f.categoryId} onChange={(e) => set({ ...f, categoryId: e.target.value })} aria-label="Categoria" className="h-11 w-full rounded-xl border border-border bg-background px-3">
        <option value="">Categoria automática</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="space-y-3.5 pb-24">
      <header className="space-y-3.5">
        <div className="flex items-center justify-between">
          <h1 className="text-[30px] font-bold tracking-tight">Extrato</h1>
          <div className="flex gap-2">
            <Link to="/transactions/avancado" aria-label="Modo avançado (IA, exportar)" title="Modo avançado (IA, exportar)" className="flex size-11 items-center justify-center rounded-[14px] border border-border bg-surface">
              <SlidersHorizontal className="size-5" strokeWidth={1.8} />
            </Link>
            <button type="button" onClick={() => setAdding((a) => !a)} aria-label="Novo lançamento" className="flex size-11 items-center justify-center rounded-[14px] bg-primary text-primary-fg">
              {adding ? <X className="size-5" /> : <Plus className="size-5" />}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-border bg-surface px-1">
          <button type="button" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="flex size-10 items-center justify-center text-muted">
            <ChevronLeft className="size-5" />
          </button>
          <span className="text-sm font-semibold capitalize">{monthLabel}</span>
          <button type="button" aria-label="Próximo mês" onClick={() => setMonth((m) => shiftMonth(m, 1))} className="flex size-10 items-center justify-center text-muted">
            <ChevronRight className="size-5" />
          </button>
        </div>
        <label className="flex h-12 items-center gap-2.5 rounded-2xl border border-border bg-surface px-3.5 text-muted">
          <Search className="size-[18px]" strokeWidth={1.8} aria-hidden />
          <span className="sr-only">Buscar transação</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por descrição, valor ou categoria" className="flex-1 bg-transparent text-sm text-foreground outline-none" />
        </label>
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChip(c.id)}
              className={cn(
                'min-h-9 rounded-full px-3.5 text-[13px]',
                chip === c.id ? 'bg-primary font-semibold text-primary-fg' : 'border border-border bg-surface font-medium',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p className="flex items-start gap-2 rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="Fechar" onClick={() => setError(null)}><X className="size-4" /></button>
        </p>
      ) : null}
      {notice ? (
        <p className="flex items-start gap-2 rounded-2xl bg-accent-muted p-3 text-sm" role="status">
          <span className="flex-1">{notice}</span>
          <button type="button" aria-label="Fechar" onClick={() => setNotice(null)}><X className="size-4" /></button>
        </p>
      ) : null}

      {adding ? (
        <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
          <h2 className="text-lg font-semibold">Novo lançamento</h2>
          {formFields(newForm, setNewForm)}
          <Button className="h-12 w-full text-base" onClick={() => void addNew()} disabled={busy}>
            {busy ? 'Salvando…' : 'Adicionar'}
          </Button>
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-0.5 rounded-[18px] border border-border bg-surface px-3.5 py-3">
          <p className="text-xs text-muted">Entradas</p>
          <p className="truncate text-[17px] font-semibold tabular-nums text-positive">+{formatBRLFromCents(income)}</p>
        </div>
        <div className="space-y-0.5 rounded-[18px] border border-border bg-surface px-3.5 py-3">
          <p className="text-xs text-muted">Saídas</p>
          <p className="truncate text-[17px] font-semibold tabular-nums">−{formatBRLFromCents(expense)}</p>
        </div>
      </div>

      {pending && chip !== 'in' ? (
        <section className="space-y-3 rounded-[22px] border border-[#f6d3bb] bg-[#fff4ec] p-4 text-[#7c2d12] dark:border-[#5a3622] dark:bg-[#2a1d15] dark:text-[#ffd9c2]">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/80 text-[#9a3412] dark:bg-black/20 dark:text-[#ffb38a]">
              <AlertCircle className="size-5" strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{merchantOf(pending)}</p>
              <p className="truncate text-xs opacity-80">
                Sem categoria · −{formatBRLFromCents(pending.amount_cents)} · {dayLabel(pending.date, today)}
                {uncategorized.length > 1 ? ` · mais ${uncategorized.length - 1}` : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pendingSuggestion ? (
              <button type="button" onClick={() => void setCategory(pending, pendingSuggestion, learn)} className="min-h-9 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-white">
                {catName.get(pendingSuggestion)}
              </button>
            ) : null}
            <select
              aria-label="Escolher categoria"
              value=""
              onChange={(e) => e.target.value && void setCategory(pending, e.target.value, learn)}
              className="min-h-9 rounded-full border border-[#f0c3a3] bg-white px-3 text-[13px] text-[#7c2d12] dark:border-[#5a3622] dark:bg-black/20 dark:text-[#ffd9c2]"
            >
              <option value="">{pendingSuggestion ? 'Outra…' : 'Escolher categoria…'}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} className="size-4" />
              criar regra “{identifyMerchant(pending.description_raw).ruleKey ?? merchantOf(pending)}”
            </label>
          </div>
        </section>
      ) : null}

      {loading ? <p className="text-sm text-muted">Carregando…</p> : null}
      {!loading && days.length === 0 ? (
        <p className="rounded-3xl border border-dashed border-border p-6 text-center text-sm text-muted">
          {q || chip !== 'all' ? 'Nada encontrado com esse filtro.' : 'Nenhum lançamento neste mês.'}{' '}
          {!q && chip === 'all' ? <Link to="/import" className="font-semibold text-foreground underline">Importar</Link> : null}
        </p>
      ) : null}

      {days.map(([day, list]) => {
        const net = list.filter(counts).reduce((s, t) => s + (t.kind === 'credit' ? t.amount_cents : -t.amount_cents), 0)
        return (
          <section key={day} className="space-y-2">
            <div className="flex justify-between px-1.5 text-[13px] text-muted">
              <span className="font-semibold text-foreground">{dayLabel(day, today)}</span>
              <span className={cn(net > 0 && 'text-positive')}>
                {net > 0 ? '+' : '−'}
                {formatBRLFromCents(Math.abs(net))}
              </span>
            </div>
            <div className="rounded-[22px] border border-border bg-surface px-1.5 py-1">
              {list.map((t, i) => {
                const cat = catName.get(t.category_id ?? '') ?? null
                const open = openId === t.id
                const ex = excludedById.get(t.id)
                return (
                  <div key={t.id} className={cn(i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
                    <button type="button" onClick={() => openRow(t)} aria-expanded={open} className="flex w-full items-center gap-3 px-2.5 py-2.5 text-left">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl font-display text-[15px] font-bold" style={tileColors(cat)}>
                        {(cat ?? merchantOf(t)).charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{merchantOf(t)}</span>
                        <span className={cn('block truncate text-xs', cat || ex ? 'text-muted' : 'text-warning')}>
                          {ex ? EXCLUDED_LABEL[ex.reason] : (cat ?? 'Sem categoria')}
                          {t.account ? ` · ${t.account}` : ''}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-sm font-semibold tabular-nums',
                          t.kind === 'credit' && !ex && 'text-positive',
                          ex && 'text-muted line-through',
                        )}
                      >
                        {t.kind === 'credit' ? '+' : '−'}
                        {formatBRLFromCents(t.amount_cents)}
                      </span>
                    </button>
                    {open && edit ? (
                      <div className="space-y-3 px-2.5 pb-3">
                        <p className="truncate font-mono text-[11px] text-muted">{t.description_raw}</p>
                        {ex ? <p className="text-xs text-muted">{ex.note}</p> : null}
                        {ex?.reason === 'duplicada' && ex.relatedId ? (
                          <div className="flex flex-wrap gap-2 rounded-xl bg-background p-2.5">
                            <Button size="sm" variant="secondary" onClick={() => confirmNotDuplicate(t, ex.relatedId!)}>
                              Não é repetida — contar
                            </Button>
                            <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove(t)}>
                              <Trash2 className="size-4" /> É repetida — apagar
                            </Button>
                          </div>
                        ) : null}
                        {formFields(edit, setEdit)}
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => void saveEdit(t)} disabled={busy}>
                            Salvar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>
                            Cancelar
                          </Button>
                          {confirmDel ? (
                            <Button size="sm" variant="danger" className="ml-auto" onClick={() => void remove(t)}>
                              Confirmar exclusão
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => setConfirmDel(true)}>
                              <Trash2 className="size-4" /> Apagar
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
