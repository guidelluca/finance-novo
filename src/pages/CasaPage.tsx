import { Check, Clock, Info, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MonthSwitcher } from '@/components/ui/month-switcher'
import { useAuth } from '@/contexts/AuthContext'
import { useMonthData } from '@/hooks/useMonthData'
import { usePeriods } from '@/hooks/usePeriods'
import { formatBRLFromCents, parseMoneyToCents } from '@/lib/currency'
import { caixinhaShare, classifyHouse, markHouseTx, readHouse, saveHouse, setCaixinha, type HouseConfig } from '@/lib/house'
import { RENT_PIX_MIN, shiftMonth, type ConsTx } from '@/lib/monthConsolidation'
import { cn } from '@/lib/utils'

const d2 = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function EditList({ label, hint, items, onChange, placeholder }: { label: string; hint: string; items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [v, setV] = useState('')
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {items.map((it) => (
          <li key={it} className="flex items-center gap-1 rounded-full border border-border bg-background py-1 pl-3 pr-1 text-sm">
            {it}
            <button type="button" aria-label={`Remover ${it}`} onClick={() => onChange(items.filter((x) => x !== it))} className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-surface">
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const t = v.trim()
          if (t && !items.includes(t)) onChange([...items, t])
          setV('')
        }}
      >
        <input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm" />
        <Button size="sm" type="submit" variant="secondary">
          <Plus className="size-4" /> Adicionar
        </Button>
      </form>
    </div>
  )
}

export function CasaPage() {
  const { user } = useAuth()
  const periods = usePeriods()
  const [month, setMonth] = useState(() => periods.current)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setMonth(periods.current)
  }, [periods.current, touched])
  const { loading, error, result, history, range } = useMonthData(month)
  const house = readHouse(user)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const cx = caixinhaShare(house, month)
  const [cxInput, setCxInput] = useState('')
  const [peopleInput, setPeopleInput] = useState('')
  useEffect(() => {
    setCxInput(cx.totalCents ? (cx.totalCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '')
    setPeopleInput(String(cx.people))
  }, [month, cx.totalCents, cx.people])
  const saveCaixinha = async () => {
    if (!user) return
    const cents = cxInput.trim() ? parseMoneyToCents(cxInput) : 0
    const people = Number(peopleInput)
    if (cents == null || Number.isNaN(cents) || cents < 0) {
      setNotice('Valor da caixinha inválido. Ex.: 300 ou 300,00')
      return
    }
    if (!Number.isFinite(people) || people < 1) {
      setNotice('Número de moradores inválido.')
      return
    }
    setBusyId('caixinha')
    try {
      await setCaixinha(user, month, cents, people)
      const per = Math.round(cents / Math.round(people))
      setNotice(
        cents
          ? `Caixinha de ${formatBRLFromCents(cents)} ÷ ${Math.round(people)} = ${formatBRLFromCents(per)} por pessoa. Somei ${formatBRLFromCents(per)} ao seu aluguel deste mês.`
          : 'Caixinha deste mês apagada.',
      )
    } catch (e) {
      setNotice(`Não consegui salvar: ${(e as Error).message}`)
    } finally {
      setBusyId(null)
    }
  }

  // aluguel com parte sua: sai da casa inteiro, e a sua parte entra na casa como contribuição sua
  const rents = result.rentShares
  const casa = useMemo(() => {
    const ex = result.excluded.filter((e) => e.reason === 'casa').map((e) => e.tx)
    const paid = rents
      .filter((r) => r.shareCents > 0)
      .map((r) => result.included.find((t) => t.id === r.txId))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({ ...t, amountCents: rents.find((r) => r.txId === t.id)!.paidCents }))
    return [...ex, ...paid]
  }, [result, rents])
  const myShare = rents.reduce((s, r) => s + Math.max(0, r.shareCents), 0)
  const talvez = useMemo(
    () => result.included.filter((t) => classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house)?.kind === 'talvez'),
    [result, house],
  )
  const fromMembers = casa.filter((t) => t.kind === 'credit').reduce((s, t) => s + t.amountCents, 0)
  const inCents = fromMembers + myShare
  const outCents = casa.filter((t) => t.kind === 'debit').reduce((s, t) => s + t.amountCents, 0)
  const net = inCents - outCents

  // saldo acumulado (últimos 6 meses + este): quanto do dinheiro da casa está com você.
  // Nos meses anteriores o aluguel fecha com a sua parte, então só a caixinha e outras contas mexem no saldo.
  const acc = useMemo(() => {
    const seen = new Set(casa.map((t) => t.id))
    let s = net
    for (const t of history as ConsTx[]) {
      if (seen.has(t.id)) continue
      const h = classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house)
      if (h?.kind !== 'casa') continue
      if (h.why === 'pagamento' && t.kind === 'debit') continue
      if (h.why === 'morador' && t.kind === 'credit' && t.amountCents >= RENT_PIX_MIN) continue
      s += t.kind === 'credit' ? t.amountCents : -t.amountCents
    }
    return s
  }, [history, casa, net, house])

  const byMember = useMemo(
    () =>
      house.members.map((m) => {
        const paid = casa.filter((t) => t.kind === 'credit' && classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house)?.who === m)
        return { name: m, cents: paid.reduce((s, t) => s + t.amountCents, 0), dates: paid.map((t) => t.date) }
      }),
    [casa, house],
  )
  const paidCount = byMember.filter((m) => m.cents > 0).length

  const mark = async (t: ConsTx & { merchant?: string }, value: 'casa' | 'meu') => {
    if (!user) return
    setBusyId(t.id)
    try {
      await markHouseTx(user, t.id, value)
      setNotice(value === 'casa' ? `${t.merchant ?? t.description}: agora é da casa.` : `${t.merchant ?? t.description}: agora é seu.`)
    } catch (e) {
      setNotice(`Não consegui salvar: ${(e as Error).message}`)
    } finally {
      setBusyId(null)
    }
  }

  const update = async (next: HouseConfig) => {
    try {
      await saveHouse(next)
      setNotice('Configuração da casa salva.')
    } catch (e) {
      setNotice(`Não consegui salvar: ${(e as Error).message}`)
    }
  }

  const row = (t: ConsTx & { merchant?: string }, actions: React.ReactNode, i: number) => (
    <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-3', i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
      <div className="min-w-[55%] flex-1">
        <p className="truncate text-sm font-medium">{t.merchant ?? t.description}</p>
        <p className="truncate text-xs text-muted">
          {d2(t.date)} · {t.account ?? '—'}
        </p>
      </div>
      <span className={cn('shrink-0 text-sm font-semibold tabular-nums', t.kind === 'credit' && 'text-positive')}>
        {t.kind === 'credit' ? '+' : '−'}
        {formatBRLFromCents(t.amountCents)}
      </span>
      <div className="flex w-full justify-end gap-1.5">{actions}</div>
    </li>
  )

  return (
    <div className="space-y-4 pb-24">
      <header className="space-y-3.5">
        <div>
          <h1 className="text-[30px] font-bold leading-tight tracking-tight">Casa</h1>
          <p className="text-sm text-muted">
            Dinheiro da {house.name} que passa pela sua conta. Só a sua parte do aluguel entra nas suas saídas.
          </p>
        </div>
        <MonthSwitcher
          month={month}
          range={range}
          onChange={(d) => {
            setTouched(true)
            setMonth((m) => shiftMonth(m, d))
          }}
        />
      </header>

      <section className="space-y-3 rounded-3xl bg-ink p-5 text-white">
        <p className="text-[13px] text-white/70">Saldo da casa no mês</p>
        <p className="font-display text-[30px] font-bold leading-none tabular-nums">
          {net < 0 ? '−' : ''}
          {formatBRLFromCents(Math.abs(net))}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-white/10 p-3">
            <p className="text-xs text-white/70">Recebido dos moradores</p>
            <p className="text-base font-semibold tabular-nums">{formatBRLFromCents(fromMembers)}</p>
          </div>
          <div className="rounded-2xl bg-white/10 p-3">
            <p className="text-xs text-white/70">Pago pela casa</p>
            <p className="text-base font-semibold tabular-nums">{formatBRLFromCents(outCents)}</p>
          </div>
        </div>
        <p className="text-[13px] text-white/80">
          {acc >= 0
            ? `Somando os últimos meses, ${formatBRLFromCents(acc)} do dinheiro da casa está com você (caixinha).`
            : `Somando os últimos meses, você adiantou ${formatBRLFromCents(-acc)} do seu dinheiro para a casa.`}
        </p>
      </section>

      <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
        <div>
          <h2 className="text-base font-semibold">Caixinha do mês</h2>
          <p className="text-xs text-muted">
            O total é dividido igualmente entre os moradores. A sua parte soma ao seu aluguel deste mês.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void saveCaixinha()
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
            Valor total (R$)
            <input
              inputMode="decimal"
              value={cxInput}
              onChange={(e) => setCxInput(e.target.value)}
              placeholder="Ex.: 300,00"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </label>
          <label className="flex w-24 flex-col gap-1 text-xs text-muted">
            Moradores
            <input
              inputMode="numeric"
              value={peopleInput}
              onChange={(e) => setPeopleInput(e.target.value.replace(/\D/g, ''))}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </label>
          <Button size="sm" type="submit" disabled={busyId === 'caixinha'} className="h-10">
            Salvar
          </Button>
        </form>
        {cx.totalCents ? (
          <p className="text-sm">
            {formatBRLFromCents(cx.totalCents)} ÷ {cx.people} = <strong>{formatBRLFromCents(cx.shareCents)}</strong> por pessoa
            {rents.length ? ' · somado ao seu aluguel' : ' · ainda não achei o pagamento do aluguel neste mês para somar'}
          </p>
        ) : null}
      </section>

      {rents.map((r) => (
        <section key={r.txId} className="space-y-2.5 rounded-3xl border border-border bg-surface p-[18px]">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold">Aluguel de {d2(r.date)}</h2>
            <span className="text-sm text-muted">{formatBRLFromCents(r.paidCents)}</span>
          </div>
          <dl className="space-y-1 text-sm">
            {r.from.map((f) => (
              <div key={f.txId} className="flex justify-between gap-3">
                <dt className="truncate text-muted">
                  {f.who} · {d2(f.date)}
                </dt>
                <dd className="shrink-0 tabular-nums">− {formatBRLFromCents(f.cents)}</dd>
              </div>
            ))}
            {r.caixinhaCents ? (
              <>
                <div className="flex justify-between gap-3 border-t border-border pt-1.5">
                  <dt className="text-muted">{r.rentPartCents >= 0 ? 'Sua parte do aluguel' : 'Sobrou do aluguel'}</dt>
                  <dd className="shrink-0 tabular-nums">{formatBRLFromCents(Math.abs(r.rentPartCents))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">
                    + caixinha {formatBRLFromCents(r.caixinhaTotalCents)} ÷ {cx.people}
                  </dt>
                  <dd className="shrink-0 tabular-nums">+ {formatBRLFromCents(r.caixinhaCents)}</dd>
                </div>
              </>
            ) : null}
            <div className="flex justify-between gap-3 border-t border-border pt-1.5 font-semibold">
              <dt>{r.shareCents >= 0 ? 'Seu aluguel no mês (conta como seu gasto)' : 'Sobrou com a casa'}</dt>
              <dd className="shrink-0 tabular-nums">{formatBRLFromCents(Math.abs(r.shareCents))}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted">
            Só a sua parte entra nas suas saídas do mês. Uso os Pix de cada morador de até 25 dias antes a 10 dias depois do aluguel (a partir de{' '}
            {formatBRLFromCents(RENT_PIX_MIN)}; menores contam como caixinha).
          </p>
        </section>
      ))}

      {notice ? (
        <p role="status" className="rounded-2xl bg-accent-muted p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      {loading ? <p className="text-sm text-muted">Carregando…</p> : null}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-lg font-semibold">Quem já pagou</h2>
          <span className="text-sm text-muted">
            {paidCount} de {house.members.length}
          </span>
        </div>
        <ul className="rounded-[22px] border border-border bg-surface px-1.5 py-1">
          {byMember.map((m, i) => (
            <li key={m.name} className={cn('flex items-center gap-3 px-2.5 py-3', i > 0 && 'border-t border-[#eeefe9] dark:border-[#2b2e34]')}>
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-xl',
                  m.cents ? 'bg-[#eef6dd] text-[#3f5a12] dark:bg-[#24301a] dark:text-[#c8f169]' : 'bg-background text-muted',
                )}
                aria-hidden
              >
                {m.cents ? <Check className="size-5" /> : <Clock className="size-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.name}</span>
                <span className="block text-xs text-muted">{m.cents ? `pagou em ${m.dates.map(d2).join(', ')}` : 'ainda não pagou neste mês'}</span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{m.cents ? formatBRLFromCents(m.cents) : '—'}</span>
            </li>
          ))}
        </ul>
      </section>

      {talvez.length ? (
        <section className="space-y-2">
          <div className="px-1">
            <h2 className="text-lg font-semibold">É da casa ou seu?</h2>
            <p className="text-xs text-muted">Pix que você mandou para moradores. Por enquanto contam como seus.</p>
          </div>
          <ul className="rounded-[22px] border border-[#f6d3bb] bg-[#fff4ec] px-1.5 py-1 dark:border-[#5a3622] dark:bg-[#2a1d15]">
            {talvez.map((t, i) =>
              row(
                t,
                <>
                  <Button size="sm" disabled={busyId === t.id} onClick={() => void mark(t, 'casa')}>
                    É da casa
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busyId === t.id} onClick={() => void mark(t, 'meu')}>
                    É meu
                  </Button>
                </>,
                i,
              ),
            )}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="px-1 text-lg font-semibold">Movimentos da casa</h2>
        {casa.length === 0 ? (
          <p className="rounded-3xl border border-dashed border-border p-5 text-center text-sm text-muted">Nada da casa neste mês.</p>
        ) : (
          <ul className="rounded-[22px] border border-border bg-surface px-1.5 py-1">
            {[...casa]
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .map((t, i) =>
                row(
                  t,
                  <Button size="sm" variant="ghost" className="text-muted" disabled={busyId === t.id} onClick={() => void mark(t, 'meu')}>
                    Não é da casa
                  </Button>,
                  i,
                ),
              )}
          </ul>
        )}
      </section>

      <details className="rounded-3xl border border-border bg-surface px-[18px] py-3.5">
        <summary className="cursor-pointer text-base font-semibold">Configurar a casa</summary>
        <div className="mt-4 space-y-5">
          <EditList
            label="Moradores"
            hint="Pix que eles mandam para você (aluguel, caixinha) é da casa. Use o nome completo, como aparece no banco."
            items={house.members}
            placeholder="Nome completo"
            onChange={(members) => void update({ ...house, members })}
          />
          <EditList
            label="Pagamentos da casa"
            hint="Quem recebe dinheiro da casa: imobiliária, condomínio, contas."
            items={house.payees}
            placeholder="Ex.: Lanza Imóveis"
            onChange={(payees) => void update({ ...house, payees })}
          />
          <EditList
            label="Palavras da caixinha"
            hint="Se a descrição tiver uma destas palavras, o lançamento é da casa."
            items={house.keywords}
            placeholder="Ex.: caixinha"
            onChange={(keywords) => void update({ ...house, keywords })}
          />
          <p className="flex items-start gap-2 text-xs text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Qualquer lançamento pode ser marcado à mão no Extrato (toque nele → “É da casa” / “É meu”).
          </p>
        </div>
      </details>
    </div>
  )
}
