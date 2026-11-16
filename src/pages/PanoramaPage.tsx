import { HandCoins, Landmark, PiggyBank, RefreshCw, Repeat, Scale, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { FutureInstallments } from '@/components/finance/FutureInstallments'
import { OfCardsPanel } from '@/components/finance/OfCardsPanel'
import { useAuth } from '@/contexts/AuthContext'
import { useRecentTxs } from '@/hooks/useRecentTxs'
import { formatBRLFromCents } from '@/lib/currency'
import { autoSync, OF_SYNC_EVENT, readAutoSync } from '@/lib/ofAutoSync'
import { checkBalances, debtsFromTxs, detectSubscriptions, netWorth } from '@/lib/ofInsights'
import { readBalanceSnapshots, readCardsCache, readConnections, readOverviewCache } from '@/lib/openFinance'
import { cn } from '@/lib/utils'

const BR = formatBRLFromCents
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const todayIso = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)

function Section({ icon: Icon, title, right, children }: { icon: typeof Landmark; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-3xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted" />
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

/** Tudo o que o Open Finance mostra além dos lançamentos: patrimônio, saldos, investimentos, dívidas, assinaturas e parcelas. */
export function PanoramaPage() {
  const { user } = useAuth()
  const conns = readConnections(user)
  const today = todayIso()
  const { txs, loading } = useRecentTxs(200)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const on = () => setTick((x) => x + 1)
    window.addEventListener(OF_SYNC_EVENT, on)
    return () => window.removeEventListener(OF_SYNC_EVENT, on)
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overview = useMemo(() => readOverviewCache(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cards = useMemo(() => readCardsCache(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sync = useMemo(() => readAutoSync(), [tick])
  const worth = netWorth(overview, cards?.cards ?? null)
  const checks = useMemo(() => checkBalances(readBalanceSnapshots(), txs), [txs, tick])
  const subs = useMemo(() => detectSubscriptions(txs, today), [txs, today])
  const debtsTx = useMemo(() => debtsFromTxs(txs, today), [txs, today])
  const subsTotal = subs.reduce((s, x) => s + x.monthlyCents, 0)

  const refresh = async () => {
    if (!user) return
    setBusy(true)
    setErr(null)
    const r = await autoSync(user, { force: true })
    if (r?.error) setErr(r.error)
    setBusy(false)
  }

  if (!conns.length)
    return (
      <div className="space-y-3 pb-24">
        <h1 className="text-[30px] font-bold tracking-tight">Panorama</h1>
        <p className="text-sm text-muted">
          Conecte seus bancos para ver saldos, investimentos, dívidas e alertas.{' '}
          <Link to="/open-finance" className="font-semibold underline">
            Configurar Open Finance
          </Link>
        </p>
      </div>
    )

  return (
    <div className="space-y-3.5 pb-24">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[30px] font-bold tracking-tight">Panorama</h1>
          <p className="text-sm text-muted">
            {sync ? `Atualizado ${new Date(sync.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Ainda não atualizado'} · atualiza sozinho 1×/dia
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-2 text-xs font-semibold">
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} /> Atualizar
        </button>
      </header>
      {err ? <p className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{err}</p> : null}
      {overview?.errors?.length ? <p className="text-xs text-muted">Alguns dados não vieram: {overview.errors.join(' · ')}</p> : null}
      {sync?.tagged ? <p className="text-xs text-muted">{sync.tagged} lançamento(s) já salvos foram marcados como transferência entre contas suas, pagamento de fatura ou aplicação (pela classificação do banco).</p> : null}

      {/* patrimônio */}
      <section className="space-y-3 rounded-[28px] bg-ink p-5 text-[#f2f3ee]">
        <p className="text-[13px] text-[#b9bdb4]">Patrimônio líquido</p>
        <p className="font-display text-[38px] font-bold leading-none">{overview ? BR(worth.total) : '—'}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-[#b9bdb4]">
          <dt>Em conta</dt>
          <dd className="text-right tabular-nums text-[#f2f3ee]">{BR(worth.cash)}</dd>
          <dt>Investido / caixinhas</dt>
          <dd className="text-right tabular-nums text-[#f2f3ee]">{BR(worth.invested)}</dd>
          <dt>Cartões (limite usado)</dt>
          <dd className="text-right tabular-nums text-[#f28c6b]">−{BR(worth.cardDebt)}</dd>
          {worth.loanDebt ? (
            <>
              <dt>Empréstimos</dt>
              <dd className="text-right tabular-nums text-[#f28c6b]">−{BR(worth.loanDebt)}</dd>
            </>
          ) : null}
        </dl>
        {!overview ? <p className="text-xs text-[#b9bdb4]">Toque em Atualizar para buscar saldos nos bancos.</p> : null}
      </section>

      {/* contas e conferência */}
      <Section icon={Scale} title="Contas e conferência de saldo">
        <ul className="space-y-1.5 text-sm">
          {(overview?.accounts ?? [])
            .filter((a) => a.type !== 'CREDIT')
            .map((a) => {
              const chk = checks.find((c) => c.label === a.label)
              return (
                <li key={a.id} className="rounded-2xl bg-background p-2.5">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">
                      {a.bank} · {a.name}
                    </span>
                    <span className={cn('tabular-nums font-semibold', a.balanceCents < 0 && 'text-danger')}>{BR(a.balanceCents)}</span>
                  </div>
                  {chk ? (
                    Math.abs(chk.diffCents) <= 100 ? (
                      <p className="text-[11px] text-positive">
                        ✓ Bate com o app de {ddmm(chk.from)} a {ddmm(chk.to)}
                      </p>
                    ) : (
                      <div className="text-[11px] text-danger">
                        <p>
                          Não bate: o banco mudou {BR(chk.bankDeltaCents)} e o app soma {BR(chk.appDeltaCents)} ({chk.diffCents > 0 ? 'faltam entradas' : 'faltam saídas'} de{' '}
                          {BR(Math.abs(chk.diffCents))}).
                        </p>
                        {chk.gaps.length ? <p className="text-muted">Procure em: {chk.gaps.map((g) => `${ddmm(g.from)}–${ddmm(g.to)} (${BR(g.diffCents)})`).join(', ')}</p> : null}
                      </div>
                    )
                  ) : (
                    <p className="text-[11px] text-muted">A conferência começa a partir da 2ª atualização (o app guarda o saldo de cada dia).</p>
                  )}
                </li>
              )
            })}
        </ul>
        {loading ? <p className="text-xs text-muted">Carregando lançamentos…</p> : null}
      </Section>

      {/* investimentos */}
      <Section icon={PiggyBank} title="Investimentos e caixinhas" right={<span className="text-xs font-semibold tabular-nums">{BR(worth.invested)}</span>}>
        {overview?.investments.length ? (
          <ul className="space-y-1 text-sm">
            {overview.investments.map((v) => (
              <li key={v.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {v.bank} · {v.name}
                </span>
                <span className="tabular-nums">{BR(v.balanceCents)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Nenhum investimento informado pelos bancos (alguns bancos não mandam caixinhas pelo Open Finance).</p>
        )}
        <p className="text-[11px] text-muted">
          Aplicações e resgates não contam como gasto nem como renda no mês. Dá para ligar uma caixinha a uma meta em{' '}
          <Link to="/metas" className="underline">
            Metas
          </Link>
          .
        </p>
      </Section>

      {/* dívidas */}
      <Section icon={HandCoins} title="Dívidas e empréstimos">
        {overview?.loans.length ? (
          <ul className="space-y-1.5 text-sm">
            {overview.loans.map((l) => (
              <li key={l.id} className="rounded-2xl bg-background p-2.5">
                <div className="flex justify-between gap-2">
                  <span className="truncate">
                    {l.bank} · {l.name}
                  </span>
                  <span className="tabular-nums font-semibold">{l.outstandingCents != null ? BR(l.outstandingCents) : '—'}</span>
                </div>
                <p className="text-[11px] text-muted">
                  {l.total ? `${l.paid ?? 0} de ${l.total} parcelas pagas` : ''}
                  {l.due ? ` · faltam ${l.due}` : ''}
                  {l.pastDue ? ` · ${l.pastDue} atrasada(s)` : ''}
                  {l.dueDate ? ` · termina ${l.dueDate.split('-').reverse().join('/')}` : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {debtsTx.length ? (
          <>
            <p className="text-xs text-muted">Pagamentos de dívida no extrato (últimos 6 meses):</p>
            <ul className="space-y-1 text-sm">
              {debtsTx.map((d) => (
                <li key={`${d.account}|${d.name}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    {d.name} <span className="text-xs text-muted">· {d.account} · último {ddmm(d.lastDate)}</span>
                  </span>
                  <span className="tabular-nums">{BR(d.avgMonthlyCents)}/mês</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {!overview?.loans.length && !debtsTx.length ? <p className="text-xs text-muted">Nenhuma dívida encontrada.</p> : null}
      </Section>

      <OfCardsPanel compact />
      <FutureInstallments txs={txs} today={today} />

      {/* assinaturas */}
      <Section icon={Repeat} title="Assinaturas e contas fixas" right={<span className="text-xs font-semibold tabular-nums">{BR(subsTotal)}/mês</span>}>
        {subs.length ? (
          <ul className="space-y-1 text-sm">
            {subs.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {s.name}
                  {s.charges > 1 ? <span className="text-xs text-muted"> · {s.charges} cobranças</span> : null}
                  {s.increasePct ? (
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-danger/10 px-1.5 text-[11px] font-semibold text-danger">
                      <TrendingUp className="size-3" /> +{Math.round(s.increasePct * 100)}%
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums">{BR(s.monthlyCents)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">{loading ? 'Carregando…' : 'Nenhuma cobrança que se repete todo mês encontrada.'}</p>
        )}
        <p className="text-[11px] text-muted">Detectado pelo que se repete todo mês nos últimos 6 meses. “+%” = subiu de preço em relação ao mês anterior.</p>
      </Section>
    </div>
  )
}
