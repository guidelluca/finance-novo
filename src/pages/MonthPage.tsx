import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Download, EyeOff, Info } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/contexts/AuthContext'
import { formatBRLFromCents } from '@/lib/currency'
import { learnRules } from '@/lib/learnRules'
import { identifyMerchant } from '@/lib/merchantIdentify'
import {
  consolidateMonth,
  shiftMonth,
  type ConsItem,
  type ConsTx,
  type Issue,
  type TxSource,
} from '@/lib/monthConsolidation'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import type { Category } from '@/types/database'

type Row = {
  id: string
  date: string
  amount_cents: number
  kind: 'debit' | 'credit'
  description_raw: string
  description_normalized: string | null
  account: string | null
  category_id: string | null
  import_batch_id: string | null
  import_file_id: string | null
  credit_card_id: string | null
}

function sourceFromParser(parserId: string | undefined): TxSource {
  if (!parserId) return 'manual'
  if (parserId === 'fatura_cartao_pdf_v1') return 'fatura'
  if (parserId === 'screenshot_ai_v1' || parserId === 'screenshot_local_v1') return 'print'
  if (parserId.startsWith('csv_')) return 'csv'
  return 'extrato'
}

const REASON_LABEL: Record<string, string> = {
  duplicada: 'Repetidas (contadas uma vez)',
  pagamento_fatura: 'Pagamento de fatura do cartão',
  transferencia_interna: 'Transferências entre suas contas',
  investimento: 'Aplicações e resgates',
}

function loadDismissed(userId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`finance:dismissed:${userId}`) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function saveDismissed(userId: string, s: Set<string>) {
  try {
    localStorage.setItem(`finance:dismissed:${userId}`, JSON.stringify([...s]))
  } catch {
    /* armazenamento indisponível: vale só nesta sessão */
  }
}

async function fetchRange(userId: string, from: string, to: string): Promise<Row[]> {
  const out: Row[] = []
  const page = 1000
  for (let i = 0; ; i += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select(
        'id, date, amount_cents, kind, description_raw, description_normalized, account, category_id, import_batch_id, import_file_id, credit_card_id',
      )
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })
      .range(i, i + page - 1)
    if (error) throw error
    out.push(...((data ?? []) as Row[]))
    if (!data || data.length < page) break
  }
  return out
}

export function MonthPage() {
  const { user } = useAuth()
  const [month, setMonth] = useState(() => format(startOfMonth(new Date()), 'yyyy-MM'))
  const [rows, setRows] = useState<Row[]>([])
  const [parserByBatch, setParserByBatch] = useState<Map<string, string>>(new Map())
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [openCat, setOpenCat] = useState<string | null>(null)
  const [showExcluded, setShowExcluded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (user) setDismissed(loadDismissed(user.id))
  }, [user])

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const start = parseISO(`${month}-01`)
      const from = format(startOfMonth(subMonths(start, 6)), 'yyyy-MM-dd')
      const to = format(endOfMonth(start), 'yyyy-MM-dd')
      const [txs, batches, cats] = await Promise.all([
        fetchRange(user.id, from, to),
        supabase.from('import_batches').select('id, parser_id').eq('user_id', user.id),
        supabase.from('categories').select('*').eq('user_id', user.id).order('sort_order'),
      ])
      setRows(txs)
      setParserByBatch(new Map(((batches.data ?? []) as { id: string; parser_id: string }[]).map((b) => [b.id, b.parser_id])))
      setCategories((cats.data ?? []) as Category[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar o mês.')
    } finally {
      setLoading(false)
    }
  }, [user, month])

  useEffect(() => {
    void load()
  }, [load])

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])

  const result = useMemo(() => {
    const toCons = (r: Row): ConsTx => ({
      id: r.id,
      date: r.date,
      amountCents: r.amount_cents,
      kind: r.kind,
      description: r.description_raw,
      merchantName: null,
      cardId: r.credit_card_id,
      account: r.account,
      categoryId: r.category_id,
      categoryName: r.category_id ? (catName.get(r.category_id) ?? null) : null,
      source: sourceFromParser(r.import_batch_id ? parserByBatch.get(r.import_batch_id) : undefined),
      importFileId: r.import_file_id,
    })
    const all = rows.map(toCons)
    return consolidateMonth(
      month,
      all.filter((t) => t.date.startsWith(month)),
      all.filter((t) => t.date < `${month}-01`),
      format(new Date(), 'yyyy-MM-dd'),
      dismissed,
    )
  }, [rows, parserByBatch, catName, month, dismissed])

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const dismiss = (issue: Issue) => {
    if (!user) return
    const next = new Set<string>(dismissed)
    next.add(issue.id)
    setDismissed(next)
    saveDismissed(user.id, next)
  }

  const deleteTx = async (id: string, label: string) => {
    if (!user) return
    if (!window.confirm(`Apagar “${label}” do extrato? Isto não pode ser desfeito.`)) return
    const { error: e } = await supabase.from('transactions').delete().eq('id', id).eq('user_id', user.id)
    if (e) {
      setNotice(`Não consegui apagar: ${e.message}`)
      return
    }
    setRows((rs) => rs.filter((r) => r.id !== id))
    setNotice('Lançamento apagado.')
  }

  const setCategory = async (tx: ConsItem, categoryId: string) => {
    if (!user) return
    const { error: e } = await supabase
      .from('transactions')
      .update({ category_id: categoryId || null })
      .eq('id', tx.id)
      .eq('user_id', user.id)
    if (e) {
      setNotice(`Não consegui salvar: ${e.message}`)
      return
    }
    setRows((rs) => rs.map((r) => (r.id === tx.id ? { ...r, category_id: categoryId || null } : r)))
    if (categoryId) {
      const key = identifyMerchant(tx.description).ruleKey
      const n = await learnRules(user.id, [{ key, categoryId }])
      if (n > 0) setNotice(`Categoria salva. Aprendi: “${key}” → ${catName.get(categoryId)} nas próximas importações.`)
    }
  }

  const exportCsv = () => {
    const lines = [['data', 'estabelecimento', 'descricao_original', 'categoria', 'conta', 'tipo', 'valor'].join(';')]
    for (const t of [...result.included].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      lines.push(
        [
          t.date,
          t.merchant,
          t.description,
          t.categoryName ?? 'Sem categoria',
          t.account ?? '',
          t.kind === 'credit' ? 'entrada' : 'saida',
          ((t.kind === 'credit' ? 1 : -1) * t.amountCents / 100).toFixed(2).replace('.', ','),
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(';'),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `extrato-consolidado-${month}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const monthLabel = format(parseISO(`${month}-01`), "MMMM 'de' yyyy", { locale: ptBR })
  const { totals } = result
  const excludedByReason = useMemo(() => {
    const m = new Map<string, typeof result.excluded>()
    for (const e of result.excluded) m.set(e.reason, [...(m.get(e.reason) ?? []), e])
    return [...m.entries()]
  }, [result])
  const itemById = useMemo(
    () => new Map([...result.included, ...result.excluded.map((e) => e.tx)].map((t) => [t.id, t])),
    [result],
  )

  return (
    <div className="space-y-5 pb-24">
      <header className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
          <ChevronLeft className="size-5" />
        </Button>
        <div className="text-center">
          <p className="text-xs text-muted">Extrato consolidado</p>
          <h1 className="text-xl font-semibold capitalize tracking-tight">{monthLabel}</h1>
        </div>
        <Button variant="ghost" size="icon" aria-label="Próximo mês" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
          <ChevronRight className="size-5" />
        </Button>
      </header>

      {error ? <p className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      {notice ? (
        <p className="rounded-xl border border-accent/40 bg-accent-muted p-3 text-sm" role="status">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-2" aria-label="Resumo do mês">
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-muted">Entrou</p>
                <p className="font-mono text-base font-semibold tabular-nums text-emerald-400">
                  {formatBRLFromCents(totals.incomeCents)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-muted">Saiu</p>
                <p className="font-mono text-base font-semibold tabular-nums">{formatBRLFromCents(totals.expenseCents)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs text-muted">Sobrou</p>
                <p
                  className={cn(
                    'font-mono text-base font-semibold tabular-nums',
                    totals.netCents < 0 ? 'text-danger' : 'text-accent',
                  )}
                >
                  {formatBRLFromCents(totals.netCents)}
                </p>
              </CardContent>
            </Card>
          </section>
          <p className="-mt-2 text-xs text-muted">
            {result.included.length} lançamentos de {result.byAccount.length} conta(s)/cartão(ões)
            {result.excluded.length ? ` · ${result.excluded.length} fora da soma (repetidos, fatura, transferências)` : ''}
          </p>

          {/* PARA REVISAR */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
                Para revisar {result.issues.length ? `(${result.issues.length})` : ''}
              </CardTitle>
              <CardDescription>
                {result.issues.length
                  ? 'O que parece errado ou merece uma olhada. Resolva ou marque como visto.'
                  : 'Nada estranho neste mês.'}
              </CardDescription>
            </CardHeader>
            {result.issues.length ? (
              <CardContent className="space-y-2">
                {result.issues.map((issue) => {
                  const txs = issue.txIds.map((id) => itemById.get(id)).filter((t): t is ConsItem => Boolean(t))
                  const dupDrop =
                    issue.type === 'duplicada'
                      ? result.excluded.find((e) => e.reason === 'duplicada' && issue.txIds.includes(e.tx.id))?.tx
                      : null
                  return (
                    <div
                      key={issue.id}
                      className={cn(
                        'rounded-xl border p-3 text-sm',
                        issue.severity === 'baixa' ? 'border-border bg-surface-elevated/40' : 'border-warning/40 bg-warning/10',
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {issue.severity === 'baixa' ? (
                          <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                        ) : (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{issue.title}</p>
                          <p className="text-xs text-muted">{issue.detail}</p>
                        </div>
                      </div>

                      {issue.type === 'sem_categoria' ? (
                        <ul className="mt-2 space-y-1.5">
                          {txs.map((t) => (
                            <li key={t.id} className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-xs">
                                {t.date.slice(8)}/{t.date.slice(5, 7)} · {t.merchant} ·{' '}
                                <span className="font-mono">{formatBRLFromCents(t.amountCents)}</span>
                              </span>
                              <select
                                aria-label={`Categoria de ${t.merchant}`}
                                className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
                                value=""
                                onChange={(e) => void setCategory(t, e.target.value)}
                              >
                                <option value="">Escolher…</option>
                                {categories.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </li>
                          ))}
                        </ul>
                      ) : txs.length ? (
                        <ul className="mt-2 space-y-1 text-xs text-muted">
                          {txs.map((t) => (
                            <li key={t.id} className="flex justify-between gap-2">
                              <span className="min-w-0 truncate">
                                {t.date.slice(8)}/{t.date.slice(5, 7)} · {t.account ?? t.source} · {byId.get(t.id)?.description_raw}
                              </span>
                              <span className="shrink-0 font-mono">{formatBRLFromCents(t.amountCents)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      <div className="mt-2 flex flex-wrap gap-2">
                        {issue.type === 'duplicada' && dupDrop ? (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => void deleteTx(dupDrop.id, dupDrop.merchant)}>
                              Apagar a repetida
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => dismiss(issue)}>
                              Não é repetida (são 2 compras)
                            </Button>
                          </>
                        ) : null}
                        {issue.type === 'cobranca_repetida' && txs[1] ? (
                          <Button size="sm" variant="secondary" onClick={() => void deleteTx(txs[1]!.id, txs[1]!.merchant)}>
                            Apagar uma
                          </Button>
                        ) : null}
                        {issue.type === 'transferencia_interna' ? (
                          <Button size="sm" variant="ghost" onClick={() => dismiss(issue)}>
                            Não, foi para outra pessoa
                          </Button>
                        ) : null}
                        {issue.type === 'conta_sem_lancamentos' || issue.type === 'recorrente_ausente' || issue.type === 'fatura_sem_detalhe' ? (
                          <Button size="sm" variant="secondary" asChild>
                            <Link to="/import">Importar</Link>
                          </Button>
                        ) : null}
                        {issue.type !== 'sem_categoria' && issue.type !== 'duplicada' && issue.type !== 'transferencia_interna' ? (
                          <Button size="sm" variant="ghost" onClick={() => dismiss(issue)}>
                            <EyeOff className="size-4" /> Está certo
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            ) : null}
          </Card>

          {/* POR CATEGORIA */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Gastos por categoria</CardTitle>
                <CardDescription>Toque numa categoria para ver os lançamentos.</CardDescription>
              </div>
              <Button size="sm" variant="secondary" onClick={exportCsv} disabled={result.included.length === 0}>
                <Download className="size-4" /> CSV
              </Button>
            </CardHeader>
            <CardContent className="space-y-1">
              {result.byCategory.length === 0 ? (
                <p className="text-sm text-muted">
                  Nenhum gasto neste mês. <Link to="/import" className="text-accent underline">Importar extrato ou fatura</Link>
                </p>
              ) : null}
              {result.byCategory.map((g) => {
                const open = openCat === g.key
                const delta = g.avg3Cents ? g.totalCents / g.avg3Cents - 1 : null
                return (
                  <div key={g.key} className="rounded-xl border border-border">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenCat(open ? null : g.key)}
                      className="flex w-full flex-col gap-1.5 p-3 text-left"
                    >
                      <span className="flex w-full items-center justify-between gap-2 text-sm">
                        <span className={cn('font-medium', !g.categoryId && 'text-warning')}>{g.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono tabular-nums">{formatBRLFromCents(g.totalCents)}</span>
                          <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
                        </span>
                      </span>
                      <span className="h-1.5 w-full rounded-full bg-border/60">
                        <span
                          className={cn('block h-1.5 rounded-full', g.categoryId ? 'bg-accent' : 'bg-warning')}
                          style={{ width: `${Math.max(2, Math.round(g.share * 100))}%` }}
                        />
                      </span>
                      <span className="flex justify-between text-xs text-muted">
                        <span>
                          {Math.round(g.share * 100)}% · {g.count} lançamento(s)
                        </span>
                        {delta != null && g.avg3Cents ? (
                          <span className={cn(delta > 0.25 && 'text-warning')}>
                            {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))}% vs média ({formatBRLFromCents(g.avg3Cents)})
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {open ? (
                      <ul className="divide-y divide-border border-t border-border">
                        {g.items.map((t) => (
                          <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{t.merchant}</p>
                              <p className="truncate text-muted">
                                {t.date.slice(8)}/{t.date.slice(5, 7)} · {t.account ?? 'Sem conta'}
                              </p>
                            </div>
                            <select
                              aria-label={`Categoria de ${t.merchant}`}
                              className="h-8 max-w-28 rounded-lg border border-border bg-background px-1 text-xs"
                              value={t.categoryId ?? ''}
                              onChange={(e) => void setCategory(t, e.target.value)}
                            >
                              <option value="">Sem categoria</option>
                              {categories.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                            <span className={cn('w-20 shrink-0 text-right font-mono tabular-nums', t.kind === 'credit' && 'text-emerald-400')}>
                              {t.kind === 'credit' ? '−' : ''}
                              {formatBRLFromCents(t.amountCents)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {/* POR CONTA */}
          {result.byAccount.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por conta e cartão</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {result.byAccount.map((a) => (
                  <div key={a.account} className="flex justify-between gap-2">
                    <span>{a.account}</span>
                    <span className="font-mono tabular-nums text-muted">
                      {a.incomeCents ? <span className="text-emerald-400">+{formatBRLFromCents(a.incomeCents)} </span> : null}
                      −{formatBRLFromCents(a.expenseCents)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {/* FORA DA SOMA */}
          {result.excluded.length ? (
            <Card>
              <CardHeader>
                <button
                  type="button"
                  aria-expanded={showExcluded}
                  onClick={() => setShowExcluded((v) => !v)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <span>
                    <CardTitle className="text-base">Fora da soma ({result.excluded.length})</CardTitle>
                    <CardDescription>Não são gastos novos: entram aqui para não contar duas vezes.</CardDescription>
                  </span>
                  <ChevronDown className={cn('size-4 text-muted transition-transform', showExcluded && 'rotate-180')} aria-hidden="true" />
                </button>
              </CardHeader>
              {showExcluded ? (
                <CardContent className="space-y-3">
                  {excludedByReason.map(([reason, list]) => (
                    <div key={reason}>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{REASON_LABEL[reason] ?? reason}</p>
                      <ul className="space-y-1 text-xs">
                        {list.map((e) => (
                          <li key={e.tx.id} className="flex justify-between gap-2">
                            <span className="min-w-0 truncate">
                              {e.tx.date.slice(8)}/{e.tx.date.slice(5, 7)} · {e.tx.merchant} — <span className="text-muted">{e.note}</span>
                            </span>
                            <span className="shrink-0 font-mono tabular-nums text-muted">{formatBRLFromCents(e.tx.amountCents)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </CardContent>
              ) : null}
            </Card>
          ) : null}

          {dismissed.size ? (
            <button
              type="button"
              className="text-xs text-muted underline"
              onClick={() => {
                if (!user) return
                setDismissed(new Set<string>())
                saveDismissed(user.id, new Set<string>())
              }}
            >
              Mostrar de novo os alertas que marquei como vistos
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
