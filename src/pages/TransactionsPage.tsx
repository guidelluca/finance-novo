import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Download, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { isFinanceLlmConfigured } from '@/lib/financeLlm'
import {
  sliceForCategorize,
  suggestCategoriesForTransactions,
  type CategorySuggestionRow,
} from '@/lib/geminiFinance'
import { normalizeTransactionLogicalDescription, transactionDedupCandidates } from '@/lib/dedupKey'
import { defaultRulePatternFromDescription, suggestCategoryId } from '@/lib/rulesEngine'
import { supabase } from '@/lib/supabase'
import type { Category, CreditCard, Rule, Transaction } from '@/types/database'
import { cn } from '@/lib/utils'
import { identifyMerchant } from '@/lib/merchantIdentify'

type Tx = Transaction & { categories: Pick<Category, 'name'> | null }

function signedAmount(t: Transaction): number {
  return t.kind === 'credit' ? t.amount_cents : -t.amount_cents
}

/** Valor em formulário BR → centavos (positivos). */
function parseBrAmountToCents(raw: string): number | null {
  const s = raw.replace(/\./g, '').replace(',', '.').trim()
  const num = Number(s)
  if (Number.isNaN(num)) return null
  return Math.round(Math.abs(num) * 100)
}

function amountToBrInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

function exportCsv(rows: Tx[]) {
  const header = ['data', 'descricao', 'valor_centavos', 'tipo', 'categoria']
  const lines = rows.map((r) =>
    [
      r.date,
      `"${r.description_raw.replace(/"/g, '""')}"`,
      String(signedAmount(r)),
      r.kind,
      r.categories?.name ?? '',
    ].join(';'),
  )
  const blob = new Blob([[header.join(';'), ...lines].join('\n')], {
    type: 'text/csv;charset=utf-8',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `financas-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function TransactionsPage() {
  const { user } = useAuth()
  const [params, setSearchParams] = useSearchParams()
  const categoryFilter = params.get('category')
  const kindFilter = params.get('kind') as 'credit' | 'debit' | null
  const monthParam = params.get('month')

  const [month, setMonth] = useState(() => {
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const parsed = parseISO(`${monthParam}-01`)
      if (!Number.isNaN(parsed.getTime())) return startOfMonth(parsed)
    }
    return startOfMonth(new Date())
  })
  const [query, setQuery] = useState('')
  const [txs, setTxs] = useState<Tx[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [cards, setCards] = useState<CreditCard[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(() => params.get('new') === '1')
  const [formError, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    description: '',
    amount: '',
    kind: 'debit' as 'debit' | 'credit',
    categoryId: '' as string,
    creditCardId: '' as string,
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    date: '',
    description: '',
    amount: '',
    kind: 'debit' as 'debit' | 'credit',
    categoryId: '' as string,
    creditCardId: '' as string,
  })
  const [editError, setEditError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [aiSuggestions, setAiSuggestions] = useState<CategorySuggestionRow[]>([])
  const [aiPick, setAiPick] = useState<Record<string, boolean>>({})
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiApplying, setAiApplying] = useState(false)

  const load = useCallback(() => {
    if (!user) return
    const start = format(startOfMonth(month), 'yyyy-MM-dd')
    const end = format(endOfMonth(month), 'yyyy-MM-dd')
    void (async () => {
      setLoading(true)
      setListError(null)
      const { data } = await supabase
        .from('transactions')
        .select('*, categories(name)')
        .eq('user_id', user.id)
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: false })
      setTxs((data as Tx[]) ?? [])
      const { data: cats } = await supabase
        .from('categories')
        .select('*')
        .eq('user_id', user.id)
        .order('sort_order')
        .order('name')
      setCategories(cats ?? [])
      const { data: r } = await supabase
        .from('rules')
        .select('*')
        .eq('user_id', user.id)
        .eq('enabled', true)
      setRules(r ?? [])
      const { data: cc } = await supabase
        .from('credit_cards')
        .select('*')
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('sort_order')
        .order('name')
      setCards((cc as CreditCard[]) ?? [])
      setLoading(false)
    })()
  }, [user, month])

  useEffect(() => {
    load()
  }, [load])

  const uncategorizedForAi = useMemo(
    () =>
      txs
        .filter((t) => !t.category_id && t.kind === 'debit')
        .map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description_raw,
          amountCents: t.amount_cents,
          kind: t.kind as 'debit' | 'credit',
        })),
    [txs],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return txs.filter((t) => {
      if (categoryFilter) {
        const name = t.categories?.name ?? 'Sem categoria'
        if (name !== categoryFilter) return false
      }
      if (kindFilter === 'credit' || kindFilter === 'debit') {
        if (t.kind !== kindFilter) return false
      }
      if (!q) return true
      return t.description_raw.toLowerCase().includes(q)
    })
  }, [txs, query, categoryFilter, kindFilter])

  // Totais da lista filtrada (topo do extrato quando há filtro de tipo)
  const filteredTotal = useMemo(
    () => filtered.reduce((sum, t) => sum + t.amount_cents, 0),
    [filtered],
  )

  const clearKindFilter = () => {
    const next = new URLSearchParams(params)
    next.delete('kind')
    setSearchParams(next, { replace: true })
  }

  const createRuleForTransaction = async (t: Tx, categoryId: string) => {
    if (!user) return
    const pattern = defaultRulePatternFromDescription(t.description_raw)
    await supabase.from('rules').insert({
      user_id: user.id,
      match_type: 'contains' as const,
      pattern,
      category_id: categoryId,
      priority: 10,
      enabled: true,
    })
    void load()
  }

  const onCategoryChange = async (t: Tx, categoryId: string | null) => {
    await supabase
      .from('transactions')
      .update({ category_id: categoryId })
      .eq('id', t.id)
    if (categoryId) await createRuleForTransaction({ ...t, category_id: categoryId }, categoryId)
    void load()
  }

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    setFormError(null)
    const cents = parseBrAmountToCents(form.amount)
    if (cents == null) return
    const normStored = form.description.toLowerCase()
    const wantLogical = normalizeTransactionLogicalDescription(normStored, form.description)
    const { data: sameBucket } = await supabase
      .from('transactions')
      .select('id, description_normalized, description_raw')
      .eq('user_id', user.id)
      .eq('date', form.date)
      .eq('amount_cents', cents)
      .eq('kind', form.kind)
    if (
      sameBucket?.some(
        (r) =>
          normalizeTransactionLogicalDescription(r.description_normalized, r.description_raw) === wantLogical,
      )
    ) {
      setFormError('Este lançamento já existe (mesma data, valor, tipo e descrição).')
      return
    }
    const dedupKeys = await transactionDedupCandidates(
      user.id,
      form.date,
      cents,
      form.kind,
      form.description,
      null,
    )
    const dedup_key = dedupKeys[0]!
    const { error } = await supabase.from('transactions').insert({
      user_id: user.id,
      date: form.date,
      amount_cents: cents,
      description_raw: form.description,
      description_normalized: normStored,
      kind: form.kind,
      category_id: form.categoryId || null,
      credit_card_id: form.creditCardId || null,
      dedup_key,
    })
    if (error?.code === '23505') {
      setFormError('Lançamento duplicado.')
      return
    }
    if (error) {
      setFormError(error.message)
      return
    }
    setShowForm(false)
    setForm({
      date: format(new Date(), 'yyyy-MM-dd'),
      description: '',
      amount: '',
      kind: 'debit',
      categoryId: '',
      creditCardId: '',
    })
    void load()
  }

  const startEdit = (t: Tx) => {
    setFormError(null)
    setEditError(null)
    setEditingId(t.id)
    setEditForm({
      date: t.date,
      description: t.description_raw,
      amount: amountToBrInput(t.amount_cents),
      kind: t.kind,
      categoryId: t.category_id ?? '',
      creditCardId: t.credit_card_id ?? '',
    })
    setShowForm(false)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditError(null)
  }

  const saveEdit = async (e: React.FormEvent, t: Tx) => {
    e.preventDefault()
    if (!user) return
    setEditError(null)
    const cents = parseBrAmountToCents(editForm.amount)
    if (cents == null) {
      setEditError('Valor inválido.')
      return
    }
    const normStored = editForm.description.toLowerCase()
    const wantLogical = normalizeTransactionLogicalDescription(normStored, editForm.description)
    const { data: sameBucket } = await supabase
      .from('transactions')
      .select('id, description_normalized, description_raw')
      .eq('user_id', user.id)
      .eq('date', editForm.date)
      .eq('amount_cents', cents)
      .eq('kind', editForm.kind)
      .neq('id', t.id)
    if (
      sameBucket?.some(
        (r) =>
          normalizeTransactionLogicalDescription(r.description_normalized, r.description_raw) === wantLogical,
      )
    ) {
      setEditError('Já existe outro lançamento igual (data, valor, tipo e descrição).')
      return
    }
    const dedupKeys = await transactionDedupCandidates(
      user.id,
      editForm.date,
      cents,
      editForm.kind,
      editForm.description,
      null,
    )
    const dedup_key = dedupKeys[0]!
    const nextCat = editForm.categoryId || null
    const { error } = await supabase
      .from('transactions')
      .update({
        date: editForm.date,
        amount_cents: cents,
        description_raw: editForm.description,
        description_normalized: normStored,
        kind: editForm.kind,
        category_id: nextCat,
        credit_card_id: editForm.creditCardId || null,
        dedup_key,
      })
      .eq('id', t.id)
      .eq('user_id', user.id)
    if (error?.code === '23505') {
      setEditError('Conflito: lançamento duplicado.')
      return
    }
    if (error) {
      setEditError(error.message)
      return
    }
    if (nextCat && nextCat !== (t.category_id ?? null)) {
      await createRuleForTransaction({ ...t, category_id: nextCat }, nextCat)
    }
    setEditingId(null)
    void load()
  }

  const runAiCategorize = async () => {
    setAiError(null)
    const names = categories.map((c) => c.name.trim()).filter(Boolean)
    if (names.length === 0) {
      setAiError('Crie pelo menos uma categoria em Categorias antes de usar a IA.')
      return
    }
    if (uncategorizedForAi.length === 0) {
      setAiError('Não há despesas sem categoria neste mês.')
      return
    }
    setAiLoading(true)
    try {
      const suggestions = await suggestCategoriesForTransactions(names, uncategorizedForAi)
      setAiSuggestions(suggestions)
      const pick: Record<string, boolean> = {}
      for (const s of suggestions) pick[s.transactionId] = true
      setAiPick(pick)
      if (suggestions.length === 0) {
        setAiError('A IA não devolveu sugestões reconhecidas. Tenta de novo ou ajusta as categorias.')
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Falha ao pedir sugestões.')
    } finally {
      setAiLoading(false)
    }
  }

  const applyAiSuggestions = async () => {
    if (!user) return
    setAiApplying(true)
    setListError(null)
    try {
      const chosen = aiSuggestions.filter((s) => aiPick[s.transactionId])
      for (const s of chosen) {
        const catId = categories.find(
          (c) => c.name.trim().toLowerCase() === s.categoryName.trim().toLowerCase(),
        )?.id
        const tx = txs.find((x) => x.id === s.transactionId)
        if (!catId || !tx) continue
        await supabase.from('transactions').update({ category_id: catId }).eq('id', tx.id).eq('user_id', user.id)
        const pattern = defaultRulePatternFromDescription(tx.description_raw)
        await supabase.from('rules').insert({
          user_id: user.id,
          match_type: 'contains' as const,
          pattern,
          category_id: catId,
          priority: 10,
          enabled: true,
        })
      }
      setAiSuggestions([])
      setAiPick({})
      void load()
    } finally {
      setAiApplying(false)
    }
  }

  const deleteTx = async (t: Tx) => {
    if (!user) return
    if (!window.confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return
    setListError(null)
    const { error } = await supabase.from('transactions').delete().eq('id', t.id).eq('user_id', user.id)
    if (error) {
      setListError(error.message)
      return
    }
    if (editingId === t.id) setEditingId(null)
    void load()
  }

  if (!user) return null

  return (
    <div className="space-y-6 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {kindFilter === 'credit' ? 'Entradas' : kindFilter === 'debit' ? 'Saídas' : 'Extrato'}
          </h1>
          {categoryFilter ? (
            <p className="text-sm text-muted">Categoria: {categoryFilter}</p>
          ) : kindFilter ? (
            <p className="text-sm text-muted">
              Total do mês:{' '}
              <strong
                className={cn(
                  'font-mono tabular-nums',
                  kindFilter === 'credit' ? 'text-positive' : 'text-danger',
                )}
              >
                {kindFilter === 'credit' ? '+' : '−'}
                {formatBRLFromCents(filteredTotal)}
              </strong>{' '}
              · {filtered.length} lançamento(s)
            </p>
          ) : (
            <p className="text-sm text-muted">Lançamentos do mês</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => exportCsv(filtered)}>
            <Download className="size-4" />
            CSV
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFormError(null)
              setShowForm((s) => !s)
            }}
          >
            <Plus className="size-4" />
            Novo
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-surface-elevated px-3 py-1.5 text-sm"
          onClick={() => setMonth((m) => subMonths(m, 1))}
        >
          ‹
        </button>
        <span className="min-w-[9rem] text-center text-sm first-letter:uppercase inline-block">
          {format(month, 'MMM yyyy', { locale: ptBR })}
        </span>
        <button
          type="button"
          className="rounded-lg border border-border bg-surface-elevated px-3 py-1.5 text-sm"
          onClick={() => setMonth((m) => subMonths(m, -1))}
        >
          ›
        </button>
        {kindFilter ? (
          <button
            type="button"
            className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20"
            onClick={clearKindFilter}
            title="Remover filtro de tipo"
          >
            {kindFilter === 'credit' ? 'Só entradas' : 'Só saídas'} ✕
          </button>
        ) : null}
        <Input
          placeholder="Buscar…"
          className="max-w-xs flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {uncategorizedForAi.length > 0 || aiSuggestions.length > 0 ? (
        <Card className="border-accent/20 bg-accent-muted/30">
          <CardHeader className="space-y-1 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-accent" aria-hidden />
              Categorizar com IA (Gemini → Groq se quota)
            </CardTitle>
            <p className="text-xs text-muted">
              As sugestões só usam os nomes das suas categorias. Até {sliceForCategorize(uncategorizedForAi).length} de{' '}
              {uncategorizedForAi.length} despesas sem categoria neste mês por pedido. Confira antes de aplicar.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {!isFinanceLlmConfigured() ? (
              <p className="text-sm text-muted">
                Em <strong className="font-medium text-foreground/90">produção</strong>, define{' '}
                <code className="rounded bg-surface-elevated px-1 text-xs">VITE_GEMINI_API_KEY</code> e/ou{' '}
                <code className="rounded bg-surface-elevated px-1 text-xs">VITE_GROQ_API_KEY</code> nas variáveis do{' '}
                <strong className="font-medium text-foreground/90">build</strong> (ex. Vercel → Production) e faz{' '}
                Redeploy. Ou <code className="rounded bg-surface-elevated px-1 text-xs">VITE_FINANCE_LLM_VIA_EDGE=true</code>{' '}
                + função Supabase <code className="rounded bg-surface-elevated px-1 text-xs">finance-llm</code> (
                <code className="text-xs">.env.example</code>). Groq faz fallback ao Gemini quando configurado.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!isFinanceLlmConfigured() || aiLoading || categories.length === 0}
                onClick={() => void runAiCategorize()}
              >
                {aiLoading ? 'Analisando…' : 'Pedir sugestões'}
              </Button>
              {aiSuggestions.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={aiApplying || !aiSuggestions.some((s) => aiPick[s.transactionId])}
                  onClick={() => void applyAiSuggestions()}
                >
                  {aiApplying ? 'A aplicar…' : 'Aplicar selecionadas'}
                </Button>
              ) : null}
            </div>
            {aiError ? <p className="text-sm text-danger">{aiError}</p> : null}
            {aiSuggestions.length > 0 ? (
              <ul className="max-h-60 space-y-2 overflow-y-auto rounded-xl border border-border/80 bg-surface/50 p-2 text-sm">
                {aiSuggestions.map((s) => {
                  const tx = txs.find((x) => x.id === s.transactionId)
                  return (
                    <li key={s.transactionId} className="flex gap-2 rounded-lg border border-border/50 bg-surface-elevated/40 p-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={aiPick[s.transactionId] ?? true}
                        onChange={(e) =>
                          setAiPick((p) => ({ ...p, [s.transactionId]: e.target.checked }))
                        }
                        aria-label={`Aplicar sugestão para ${tx?.description_raw ?? s.transactionId}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 font-medium">{tx?.description_raw ?? s.transactionId}</p>
                        <p className="text-xs text-muted">
                          {tx ? formatBRLFromCents(signedAmount(tx)) : ''} ·{' '}
                          <span className="font-medium text-accent">{s.categoryName}</span> · confiança: {s.confidence}
                        </p>
                        {s.reason ? <p className="mt-0.5 text-xs text-muted">{s.reason}</p> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Novo lançamento</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={addManual} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Data</Label>
                  <Input
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <Label>Tipo</Label>
                  <select
                    className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                    value={form.kind}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, kind: e.target.value as 'debit' | 'credit' }))
                    }
                  >
                    <option value="debit">Saída</option>
                    <option value="credit">Entrada</option>
                  </select>
                </div>
              </div>
              <div>
                <Label>Descrição</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  required
                />
              </div>
              <div>
                <Label>Valor (ex.: 49,90)</Label>
                <Input
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  required
                />
              </div>
              <div>
                <Label>Categoria</Label>
                <select
                  className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                  value={form.categoryId}
                  onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
                >
                  <option value="">—</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              {cards.length > 0 ? (
                <div>
                  <Label>Cartão (se for compra no cartão)</Label>
                  <select
                    className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                    value={form.creditCardId}
                    onChange={(e) => setForm((f) => ({ ...f, creditCardId: e.target.value }))}
                  >
                    <option value="">— sem cartão —</option>
                    {cards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.last4 ? ` (final ${c.last4})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {formError ? <p className="text-sm text-danger">{formError}</p> : null}
              <Button type="submit">Salvar</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {listError ? (
        <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {listError}
        </p>
      ) : null}

      {loading ? (
        <p className="text-muted">Carregando…</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((t) => {
            const suggested = suggestCategoryId(t.description_raw, rules)
            const isEditing = editingId === t.id
            if (isEditing) {
              return (
                <li
                  key={t.id}
                  className="rounded-2xl border border-accent/40 bg-surface-elevated/90 p-3"
                >
                  <form onSubmit={(e) => void saveEdit(e, t)} className="space-y-3">
                    <p className="text-xs font-medium text-muted">Editar lançamento</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>Data</Label>
                        <Input
                          type="date"
                          value={editForm.date}
                          onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))}
                          required
                        />
                      </div>
                      <div>
                        <Label>Tipo</Label>
                        <select
                          className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                          value={editForm.kind}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              kind: e.target.value as 'debit' | 'credit',
                            }))
                          }
                        >
                          <option value="debit">Saída</option>
                          <option value="credit">Entrada</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <Label>Descrição</Label>
                      <Input
                        value={editForm.description}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, description: e.target.value }))
                        }
                        required
                      />
                    </div>
                    <div>
                      <Label>Valor</Label>
                      <Input
                        inputMode="decimal"
                        value={editForm.amount}
                        onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                        required
                      />
                    </div>
                    <div>
                      <Label>Categoria</Label>
                      <select
                        className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                        value={editForm.categoryId}
                        onChange={(e) => setEditForm((f) => ({ ...f, categoryId: e.target.value }))}
                      >
                        <option value="">—</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {cards.length > 0 ? (
                      <div>
                        <Label>Cartão</Label>
                        <select
                          className="flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                          value={editForm.creditCardId}
                          onChange={(e) => setEditForm((f) => ({ ...f, creditCardId: e.target.value }))}
                        >
                          <option value="">— sem cartão —</option>
                          {cards.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                              {c.last4 ? ` (final ${c.last4})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {editError ? <p className="text-sm text-danger">{editError}</p> : null}
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm">
                        Salvar
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={cancelEdit}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                </li>
              )
            }
            return (
              <li
                key={t.id}
                className="rounded-2xl border border-border bg-surface-elevated/70 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{identifyMerchant(t.description_raw).name}</p>
                    <p className="font-mono text-[11px] leading-snug text-muted">{t.description_raw}</p>
                    <p className="text-xs text-muted">
                      {format(new Date(t.date), "EEE dd MMM", { locale: ptBR })} ·{' '}
                      {t.kind === 'credit' ? 'Entrada' : 'Saída'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'font-mono text-sm tabular-nums',
                        signedAmount(t) >= 0 ? 'text-positive' : 'text-danger',
                      )}
                    >
                      {formatBRLFromCents(signedAmount(t))}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-8 shrink-0"
                      title="Editar"
                      onClick={() => startEdit(t)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-8 shrink-0 text-danger hover:text-danger"
                      title="Excluir"
                      onClick={() => void deleteTx(t)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                    value={t.category_id ?? ''}
                    onChange={(e) =>
                      void onCategoryChange(t, e.target.value || null)
                    }
                  >
                    <option value="">{suggested ? '(sugerida)' : 'Sem categoria'}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {suggested && !t.category_id ? (
                    <span className="text-[10px] text-muted">Regra pode aplicar</span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {!loading && filtered.length === 0 ? (
        <p className="text-center text-sm text-muted">Nenhum lançamento encontrado.</p>
      ) : null}
    </div>
  )
}
