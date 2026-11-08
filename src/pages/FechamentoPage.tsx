import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Check, ChevronLeft, ChevronRight, CircleDashed, Mail, Plus, TriangleAlert, Trash2, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useCoverage } from '@/hooks/useCoverage'
import { useMonthData } from '@/hooks/useMonthData'
import { saveAccounts, setCoverageMark, type AccountCoverage, type TrackedAccount } from '@/lib/accounts'
import { shiftMonth } from '@/lib/monthConsolidation'
import { cn } from '@/lib/utils'

const d2 = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function statusText(c: AccountCoverage): string {
  if (c.manual) return 'Marcado como completo por você'
  if (c.status === 'completo') return `${c.count} lançamento(s) · ${d2(c.coveredFrom!)} a ${d2(c.coveredTo!)}`
  if (c.status === 'em_andamento')
    return c.account.kind === 'cartao' ? 'Fatura deste mês ainda não fechou' : `Em dia até ${d2(c.coveredTo ?? '')} · mês em andamento`
  if (c.status === 'falta') return c.account.kind === 'cartao' ? 'Nenhuma fatura importada' : 'Nenhum extrato importado'
  const g = c.gaps[0]!
  const last = c.gaps[c.gaps.length - 1]!
  if (c.gaps.length === 1 && g.to === last.to && c.coveredTo && g.from > c.coveredTo)
    return `Último lançamento em ${d2(c.coveredTo)} — falta de ${d2(g.from)} em diante`
  return `Falta ${c.gaps.map((x) => (x.from === x.to ? d2(x.from) : `${d2(x.from)} a ${d2(x.to)}`)).join(', ')}`
}

export function FechamentoPage() {
  const { user } = useAuth()
  const today = format(new Date(), 'yyyy-MM-dd')
  // até o dia 10, o mês a fechar é o anterior
  const [month, setMonth] = useState(() => (Number(today.slice(8)) <= 10 ? shiftMonth(today.slice(0, 7), -1) : today.slice(0, 7)))
  const cov = useCoverage(month)
  const cons = useMonthData(month)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'conta' | 'cartao'>('conta')

  const pend = useMemo(() => {
    const r = cons.result
    const uncategorized = r.issues.find((i) => i.type === 'sem_categoria')?.txIds.length ?? 0
    const dups = r.excluded.filter((e) => e.reason === 'duplicada').length
    const suspicious = r.issues.filter((i) => i.type === 'categoria_suspeita').length
    const others = r.issues.filter(
      (i) => !['sem_categoria', 'categoria_suspeita', 'duplicada', 'estorno', 'transferencia_interna', 'conta_sem_lancamentos'].includes(i.type) && i.severity !== 'baixa',
    ).length
    return { uncategorized, dups, suspicious, others, total: uncategorized + dups + suspicious + others }
  }, [cons.result])

  const mark = async (c: AccountCoverage, ok: boolean) => {
    if (!user) return
    setBusy(c.account.id)
    try {
      await setCoverageMark(user, month, c.account.id, ok)
      setNotice(ok ? `${c.account.name}: marcado como completo.` : `${c.account.name}: marcação desfeita.`)
    } catch (e) {
      setNotice(`Não consegui salvar: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const updateAccounts = async (list: TrackedAccount[]) => {
    try {
      await saveAccounts(list)
      setNotice('Lista de contas atualizada.')
    } catch (e) {
      setNotice(`Não consegui salvar: ${(e as Error).message}`)
    }
  }

  const monthLabel = format(parseISO(`${month}-01`), "LLLL 'de' yyyy", { locale: ptBR })
  const monthName = format(parseISO(`${month}-01`), 'LLLL', { locale: ptBR })
  const allAccounts = cov.done === cov.total
  const closed = allAccounts && pend.total === 0 && !cov.loading && !cons.loading
  const pct = cov.total ? Math.round(((cov.done / cov.total) * 0.7 + (pend.total === 0 ? 0.3 : 0)) * 100) : 0
  const missing = cov.coverage.filter((c) => c.status === 'falta' || c.status === 'parcial')

  return (
    <div className="space-y-4 pb-24">
      <header className="space-y-3.5">
        <h1 className="text-[30px] font-bold tracking-tight">Fechamento do mês</h1>
        <div className="flex items-center justify-between rounded-2xl border border-border bg-surface px-1">
          <button type="button" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="flex size-10 items-center justify-center text-muted">
            <ChevronLeft className="size-5" />
          </button>
          <span className="text-sm font-semibold capitalize">{monthLabel}</span>
          <button type="button" aria-label="Próximo mês" onClick={() => setMonth((m) => shiftMonth(m, 1))} className="flex size-10 items-center justify-center text-muted">
            <ChevronRight className="size-5" />
          </button>
        </div>
      </header>

      <section className="space-y-3 rounded-3xl bg-ink p-5 text-white">
        <p className="text-[13px] text-white/70">{closed ? 'Tudo certo' : 'Para fechar o mês'}</p>
        <p className="font-display text-[26px] font-bold leading-tight">
          {cov.loading || cons.loading
            ? 'Conferindo…'
            : closed
              ? `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} fechado ✓`
              : `${cov.done} de ${cov.total} contas completas`}
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso do fechamento">
          <div className="h-full rounded-full bg-lime" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[13px] text-white/80">
          {closed
            ? 'Todos os extratos importados e nada pendente: dá para confiar nos números de entrada e saída.'
            : [
                missing.length ? `Faltam extratos: ${missing.map((c) => c.account.name).join(', ')}.` : null,
                pend.total ? `${pend.total} pendência(s) para você olhar.` : null,
              ]
                .filter(Boolean)
                .join(' ')}
        </p>
      </section>

      {notice ? (
        <p role="status" className="rounded-2xl bg-accent-muted p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {cov.error ? <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger">{cov.error}</p> : null}

      <section className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-lg font-semibold">Extratos por conta</h2>
          <button type="button" onClick={() => setEditing((e) => !e)} className="text-sm font-semibold underline">
            {editing ? 'Pronto' : 'Editar contas'}
          </button>
        </div>
        <div className="rounded-[22px] border border-border bg-surface px-1.5 py-1">
          {cov.coverage.map((c, i) => {
            const ok = c.status === 'completo' || c.status === 'em_andamento'
            return (
              <div key={c.account.id} className={cn('flex flex-wrap items-center gap-3 px-2.5 py-3', i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
                <span
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-xl',
                    ok ? 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]' : c.status === 'parcial' ? 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]' : 'bg-background text-muted',
                  )}
                  aria-hidden
                >
                  {ok ? <Check className="size-5" /> : c.status === 'parcial' ? <TriangleAlert className="size-5" /> : <CircleDashed className="size-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {c.account.name}
                    <span className="sr-only">: {ok ? 'completo' : c.status === 'parcial' ? 'incompleto' : 'faltando'}</span>
                  </p>
                  <p className={cn('text-xs', ok ? 'text-muted' : 'text-warning')}>{statusText(c)}</p>
                </div>
                {editing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Parar de acompanhar ${c.account.name}`}
                    onClick={() => void updateAccounts(cov.accounts.filter((a) => a.id !== c.account.id))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : (
                  <div className="flex gap-1.5">
                    {c.manual ? (
                      <Button size="sm" variant="ghost" disabled={busy === c.account.id} onClick={() => void mark(c, false)}>
                        Desfazer
                      </Button>
                    ) : !ok ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={busy === c.account.id} onClick={() => void mark(c, true)}>
                          {c.status === 'falta' ? 'Não usei' : 'Está completo'}
                        </Button>
                        <Button size="sm" asChild>
                          <Link to={`/import?account=${encodeURIComponent(c.account.id)}`}>
                            <Upload className="size-4" /> Importar
                          </Link>
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2 border-t border-[#eeefe9] px-2.5 py-3 dark:border-[#2b2e34]"
              onSubmit={(e) => {
                e.preventDefault()
                const name = newName.trim()
                if (!name) return
                const id = `${name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`
                void updateAccounts([...cov.accounts, { id, name, kind: newKind }])
                setNewName('')
              }}
            >
              <label className="sr-only" htmlFor="new-acc">
                Nome da conta
              </label>
              <input id="new-acc" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ex.: Cartão Nubank" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm" />
              <select aria-label="Tipo" value={newKind} onChange={(e) => setNewKind(e.target.value as 'conta' | 'cartao')} className="h-10 rounded-xl border border-border bg-background px-2 text-sm">
                <option value="conta">Conta</option>
                <option value="cartao">Cartão</option>
              </select>
              <Button size="sm" type="submit">
                <Plus className="size-4" /> Adicionar
              </Button>
            </form>
          ) : null}
        </div>
        <p className="px-1 text-xs text-muted">
          Cada arquivo importado cobre do primeiro ao último lançamento dele. Se a conta não teve movimento no fim do mês, toque em “Está completo”.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="px-1 text-lg font-semibold">Pendências para você</h2>
        <div className="rounded-[22px] border border-border bg-surface px-1.5 py-1">
          {[
            { n: pend.uncategorized, label: 'sem categoria', to: `/transactions?month=${month}&category=none` },
            { n: pend.dups, label: 'possíveis repetidas (não estão contando)', to: `/transactions?month=${month}&filtro=dup` },
            { n: pend.suspicious, label: 'categorias que parecem erradas', to: '/mes' },
            { n: pend.others, label: 'outros alertas (cobrança em dobro, valor fora do normal…)', to: '/mes' },
          ].map((p, i) => (
            <Link key={p.label} to={p.to} className={cn('flex items-center gap-3 px-2.5 py-3', i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
              <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl font-display text-[15px] font-bold', p.n ? 'bg-[#fff4ec] text-[#9a3412] dark:bg-[#2a1d15] dark:text-[#ffb38a]' : 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]')}>
                {p.n || <Check className="size-5" aria-label="nenhuma" />}
              </span>
              <span className="flex-1 text-sm">{p.label.charAt(0).toUpperCase() + p.label.slice(1)}</span>
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </Link>
          ))}
        </div>
      </section>

      <section className="flex items-start gap-3 rounded-3xl border border-border bg-surface p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background">
          <Mail className="size-5" strokeWidth={1.8} />
        </span>
        <p className="text-sm text-muted">
          Todo dia 2 você recebe um e-mail lembrando de importar os extratos do mês que passou e fechar o mês aqui. O Início também avisa enquanto o mês anterior não estiver fechado.
        </p>
      </section>
    </div>
  )
}
