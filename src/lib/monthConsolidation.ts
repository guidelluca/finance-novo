/**
 * Extrato consolidado do mês: junta todas as contas e cartões, tira repetições,
 * separa o que não é gasto (pagamento de fatura, transferência entre contas, investimento),
 * agrupa por categoria e aponta o que merece revisão.
 *
 * Sem dependências externas (testável isoladamente). Nada é apagado aqui: só classifica.
 */
import { identifyMerchant } from './merchantIdentify'

export type TxSource = 'fatura' | 'extrato' | 'csv' | 'print' | 'manual'

export type ConsTx = {
  id: string
  date: string // YYYY-MM-DD
  amountCents: number // positivo
  kind: 'debit' | 'credit'
  description: string
  account: string | null
  categoryId: string | null
  categoryName: string | null
  source: TxSource
  importFileId: string | null
  /** nome legível do estabelecimento, se já conhecido */
  merchantName?: string | null
  /** ligado a um cartão cadastrado (transactions.credit_card_id) */
  cardId?: string | null
}

export type ConsItem = ConsTx & { merchant: string; merchantKey: string; merchantKind: string | null }

export type ExcludedReason = 'duplicada' | 'pagamento_fatura' | 'transferencia_interna' | 'investimento'

export type Excluded = { tx: ConsItem; reason: ExcludedReason; relatedId?: string; note: string }

export type IssueType =
  | 'duplicada'
  | 'possivel_duplicada'
  | 'cobranca_repetida'
  | 'valor_fora_padrao'
  | 'assinatura_mudou'
  | 'recorrente_ausente'
  | 'tarifa'
  | 'sem_categoria'
  | 'fatura_sem_detalhe'
  | 'conta_sem_lancamentos'
  | 'categoria_acima'
  | 'transferencia_interna'

export type Severity = 'alta' | 'media' | 'baixa'

export type Issue = {
  /** estável: permite "marcar como visto" */
  id: string
  type: IssueType
  severity: Severity
  title: string
  detail: string
  txIds: string[]
}

export type CategoryGroup = {
  key: string
  categoryId: string | null
  name: string
  totalCents: number
  count: number
  share: number // 0–1 dos gastos
  avg3Cents: number | null // média dos 3 meses anteriores
  items: ConsItem[]
}

export type ConsolidatedMonth = {
  month: string // YYYY-MM
  dismissedCount: number
  included: ConsItem[]
  excluded: Excluded[]
  totals: { incomeCents: number; expenseCents: number; netCents: number }
  byCategory: CategoryGroup[]
  incomeByCategory: CategoryGroup[]
  byAccount: { account: string; expenseCents: number; incomeCents: number; count: number }[]
  issues: Issue[]
}

const SOURCE_PRIORITY: Record<TxSource, number> = { fatura: 5, extrato: 4, csv: 3, print: 2, manual: 1 }

const CARD_PAYMENT =
  /fatura paga|pagamento (de |da )?fatura|pgto\.? ?fatura|pag(to|amento)? (de )?cart[aã]o|fatura (do |de )?cart[aã]o|itaucard|nu ?pagamentos|pagamento.*\b(nubank|picpay card|cart[aã]o)\b|d[eé]bito autom[aá]tico.*fatura/i
const INVESTMENT =
  /\b(aplica[cç][aã]o|resgate|rdb|cdb|lci|lca|tesouro direto|poupan[cç]a|caixinha|cofrinho|porquinho|investimento|guardado|guardar dinheiro)\b/i
const SELF_TRANSFER = /conta pr[oó]pria|mesma titularidade/i
const TRANSFER_HINT = /\b(pix|transf|transfer[eê]ncia|ted|doc)\b/i
const FEE = /\b(anuidade|tarifa|juros|multa|encargo|mora|iof|cesta de servi[cç]os|pacote de servi[cç]os)\b/i
const APP_RIDE = /uber|\b99\b|99 \(|cabify|indrive/i

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000)
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

export function shiftMonth(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const t = y * 12 + (m - 1) + k
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function keyOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\(parcela \d+\/\d+\)/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function enrich(t: ConsTx): ConsItem {
  const m = identifyMerchant(t.description)
  const name = t.merchantName?.trim() || m.name
  return { ...t, merchant: name, merchantKey: keyOf(name), merchantKind: m.kind }
}

function isCard(t: { account: string | null; cardId?: string | null }): boolean {
  return Boolean(t.cardId) || /^cart[aã]o\b|cr[eé]dito/i.test(t.account ?? '')
}

/** Palavras genéricas que não identificam o estabelecimento */
const GENERIC = new Set(
  ('supermercados supermercado mercado mercados restaurante restaurantes lanchonete lanches ifood compra compras credito ' +
    'debito pagamento posto farmacia drogaria uber corrida pix enviado enviada recebido recebida transferencia loja lojas ' +
    'comercio paulo campinas brasil delivery cartao conta parcela via maquininha shop store food')
    .split(' '),
)

function distinctiveWords(key: string): string[] {
  return key.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w))
}

/** Mesmo estabelecimento, escrito de jeitos diferentes por fontes diferentes? */
export function similarMerchant(a: ConsItem, b: ConsItem): boolean {
  if (a.merchantKey && a.merchantKey === b.merchantKey) return true
  const wa = distinctiveWords(a.merchantKey)
  const wb = new Set(distinctiveWords(b.merchantKey))
  if (wa.some((w) => wb.has(w))) return true
  const da = keyOf(a.description)
  const db = keyOf(b.description)
  return wa.some((w) => db.includes(w)) || [...wb].some((w) => da.includes(w))
}

export function issueId(type: IssueType, ids: string[], extra = ''): string {
  return `${type}:${[...ids].sort().join(',')}${extra ? ':' + extra : ''}`
}

/**
 * @param monthTxs lançamentos do mês (todas as contas)
 * @param history lançamentos dos ~6 meses anteriores (para padrões e médias)
 * @param today YYYY-MM-DD
 */
export function consolidateMonth(
  month: string,
  monthTxs: ConsTx[],
  history: ConsTx[],
  today: string,
  /** ids de alertas que o usuário marcou como "está certo" / "não é repetida" */
  dismissed: Set<string> = new Set(),
): ConsolidatedMonth {
  const items = monthTxs.filter((t) => monthOf(t.date) === month).map(enrich)
  const hist = history.filter((t) => t.date < `${month}-01`).map(enrich)
  const issues: Issue[] = []
  const excluded = new Map<string, Excluded>()
  const exclude = (tx: ConsItem, reason: ExcludedReason, note: string, relatedId?: string) => {
    if (!excluded.has(tx.id)) excluded.set(tx.id, { tx, reason, note, relatedId })
  }

  // 1) Investimentos (aplicação/resgate) não são gasto nem receita
  for (const t of items) {
    if (INVESTMENT.test(t.description)) exclude(t, 'investimento', t.kind === 'debit' ? 'Aplicação' : 'Resgate')
  }

  // 1b) Pix/TED para você mesmo (o leitor do extrato marca "conta própria" pelo nome do titular)
  for (const t of items) {
    if (excluded.has(t.id) || !SELF_TRANSFER.test(t.description)) continue
    exclude(t, 'transferencia_interna', t.kind === 'debit' ? 'Pix para outra conta sua' : 'Pix vindo de outra conta sua')
  }

  // 2) Pagamento de fatura do cartão: as compras já entram uma a uma pela fatura
  const cardTxNearby = [...items, ...hist].some(
    (t) => isCard(t) && (monthOf(t.date) === month || monthOf(t.date) === shiftMonth(month, -1)),
  )
  for (const t of items) {
    if (t.kind !== 'debit' || isCard(t) || excluded.has(t.id)) continue
    if (!CARD_PAYMENT.test(t.description)) continue
    if (cardTxNearby) {
      exclude(t, 'pagamento_fatura', 'As compras do cartão já estão contadas uma a uma')
    } else {
      issues.push({
        id: issueId('fatura_sem_detalhe', [t.id]),
        type: 'fatura_sem_detalhe',
        severity: 'media',
        title: `Pagamento de fatura de ${brl(t.amountCents)} sem o detalhe das compras`,
        detail:
          'Nenhuma compra de cartão foi importada para este período. O pagamento está contado como um gasto único; importe a fatura (PDF ou print) para ver onde foi o dinheiro — aí ele sai da soma sozinho.',
        txIds: [t.id],
      })
    }
  }

  // 3) Duplicadas entre fontes (ex.: print + fatura, extrato PDF + CSV)
  const live = () => items.filter((t) => !excluded.has(t.id))
  type Pair = { a: ConsItem; b: ConsItem; score: number }
  const pairs: Pair[] = []
  const pool = live()
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!
      const b = pool[j]!
      if (a.kind !== b.kind || a.amountCents !== b.amountCents) continue
      const dd = dayDiff(a.date, b.date)
      if (dd > 3) continue
      const sameSource = (a.importFileId ?? `m:${a.id}`) === (b.importFileId ?? `m:${b.id}`)
      if (sameSource) continue
      const sim = similarMerchant(a, b)
      pairs.push({ a, b, score: (sim ? 10 : 0) + (3 - dd) + (a.account === b.account ? 1 : 0) })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  const paired = new Set<string>()
  for (const { a, b, score } of pairs) {
    if (paired.has(a.id) || paired.has(b.id)) continue
    const strong = score >= 10 // mesmo estabelecimento, mesmo valor, até 3 dias
    if (strong && dismissed.has(issueId('duplicada', [a.id, b.id]))) continue // usuário disse: são 2 compras
    if (strong) {
      const [keep, drop] =
        SOURCE_PRIORITY[a.source] >= SOURCE_PRIORITY[b.source] ? [a, b] : [b, a]
      paired.add(a.id)
      paired.add(b.id)
      exclude(drop, 'duplicada', `Mesma compra já contada (${keep.account ?? keep.source}, ${keep.date.slice(8)}/${keep.date.slice(5, 7)})`, keep.id)
      issues.push({
        id: issueId('duplicada', [keep.id, drop.id]),
        type: 'duplicada',
        severity: 'media',
        title: `Repetida: ${keep.merchant} · ${brl(keep.amountCents)}`,
        detail: `Aparece em duas importações (${keep.account ?? keep.source} e ${drop.account ?? drop.source}). Contei uma vez só. Se forem duas compras de verdade, marque "não é repetida".`,
        txIds: [keep.id, drop.id],
      })
    } else if (dayDiff(a.date, b.date) <= 1 && !APP_RIDE.test(a.merchant + b.merchant)) {
      issues.push({
        id: issueId('possivel_duplicada', [a.id, b.id]),
        type: 'possivel_duplicada',
        severity: 'baixa',
        title: `Talvez repetida: ${brl(a.amountCents)} em ${a.merchant} e ${b.merchant}`,
        detail: 'Mesmo valor, datas próximas e fontes diferentes, mas nomes diferentes. Confira se é a mesma compra.',
        txIds: [a.id, b.id],
      })
    }
  }

  // 4) Transferência entre contas próprias: saída numa conta + entrada igual em outra
  const nowLive = live()
  for (const d of nowLive) {
    if (d.kind !== 'debit' || isCard(d) || excluded.has(d.id)) continue
    const c = nowLive.find(
      (x) =>
        x.kind === 'credit' &&
        !excluded.has(x.id) &&
        x.amountCents === d.amountCents &&
        x.account &&
        d.account &&
        x.account !== d.account &&
        dayDiff(x.date, d.date) <= 1 &&
        (TRANSFER_HINT.test(d.description) || TRANSFER_HINT.test(x.description)),
    )
    if (!c) continue
    if (dismissed.has(issueId('transferencia_interna', [d.id, c.id]))) continue
    exclude(d, 'transferencia_interna', `Foi para ${c.account}`, c.id)
    exclude(c, 'transferencia_interna', `Veio de ${d.account}`, d.id)
    issues.push({
      id: issueId('transferencia_interna', [d.id, c.id]),
      type: 'transferencia_interna',
      severity: 'baixa',
      title: `Transferência entre suas contas: ${brl(d.amountCents)}`,
      detail: `${d.account} → ${c.account}. Tirei da soma de gastos e de entradas. Se foi para outra pessoa, marque como não.`,
      txIds: [d.id, c.id],
    })
  }

  const included = items.filter((t) => !excluded.has(t.id))
  const expenses = included.filter((t) => t.kind === 'debit')
  const incomes = included.filter((t) => t.kind === 'credit')
  // estorno/reembolso no cartão abate gasto da mesma categoria
  const cardRefunds = incomes.filter((t) => isCard(t))
  const realIncomes = incomes.filter((t) => !isCard(t))

  const expenseCents = expenses.reduce((s, t) => s + t.amountCents, 0) - cardRefunds.reduce((s, t) => s + t.amountCents, 0)
  const incomeCents = realIncomes.reduce((s, t) => s + t.amountCents, 0)

  // 5) Repetida dentro da mesma fonte (mesmo dia, valor e estabelecimento)
  const seenSame = new Map<string, ConsItem[]>()
  for (const t of expenses) {
    const k = `${t.importFileId ?? 'manual'}|${t.date}|${t.amountCents}|${t.merchantKey}`
    seenSame.set(k, [...(seenSame.get(k) ?? []), t])
  }
  for (const group of seenSame.values()) {
    if (group.length < 2) continue
    const t = group[0]!
    const ride = APP_RIDE.test(t.merchant)
    issues.push({
      id: issueId('cobranca_repetida', group.map((g) => g.id)),
      type: 'cobranca_repetida',
      severity: ride ? 'baixa' : 'media',
      title: `${group.length}× ${brl(t.amountCents)} em ${t.merchant} no mesmo dia`,
      detail: ride
        ? 'Comum em corridas, mas vale conferir se não houve cobrança em dobro.'
        : 'Pode ser cobrança em dobro. Confira no app do banco; se for, dá para contestar.',
      txIds: group.map((g) => g.id),
    })
  }

  // 6) Tarifas, juros, multas, IOF
  for (const t of expenses) {
    if (!FEE.test(t.description) && !FEE.test(t.merchant)) continue
    const iofIntl = /iof/i.test(t.description) && /internac|exterior/i.test(t.description)
    issues.push({
      id: issueId('tarifa', [t.id]),
      type: 'tarifa',
      severity: iofIntl ? 'baixa' : 'media',
      title: `${iofIntl ? 'IOF de compra internacional' : 'Tarifa/juros'}: ${brl(t.amountCents)}`,
      detail: iofIntl
        ? `${t.account ?? ''} — imposto sobre compras no exterior.`
        : `${t.merchant} (${t.account ?? 'conta'}). Tarifas e juros às vezes dá para evitar ou contestar.`,
      txIds: [t.id],
    })
  }

  // 7) Padrões do histórico por estabelecimento
  const histExp = hist.filter((t) => t.kind === 'debit' && !INVESTMENT.test(t.description) && !CARD_PAYMENT.test(t.description) && !SELF_TRANSFER.test(t.description))
  const byMerchant = new Map<string, ConsItem[]>()
  for (const t of histExp) byMerchant.set(t.merchantKey, [...(byMerchant.get(t.merchantKey) ?? []), t])

  const thisMonthByMerchant = new Map<string, ConsItem[]>()
  for (const t of expenses) thisMonthByMerchant.set(t.merchantKey, [...(thisMonthByMerchant.get(t.merchantKey) ?? []), t])

  for (const [, list] of thisMonthByMerchant) {
    const past = histExp.filter((p) => similarMerchant(list[0]!, p))
    // valor fora do padrão
    if (past.length >= 3) {
      const med = median(past.map((p) => p.amountCents))
      for (const t of list) {
        if (t.amountCents > Math.max(med * 2.5, med + 10_000)) {
          issues.push({
            id: issueId('valor_fora_padrao', [t.id]),
            type: 'valor_fora_padrao',
            severity: 'media',
            title: `Valor alto em ${t.merchant}: ${brl(t.amountCents)}`,
            detail: `Normalmente fica em torno de ${brl(Math.round(med))}. Confira se o valor está certo.`,
            txIds: [t.id],
          })
        }
      }
    }
    // assinatura que mudou de valor
    const pastMonths = new Map<string, number[]>()
    for (const p of past) pastMonths.set(monthOf(p.date), [...(pastMonths.get(monthOf(p.date)) ?? []), p.amountCents])
    const monthly = [...pastMonths.entries()].filter(([, v]) => v.length === 1).sort(([a], [b]) => (a < b ? -1 : 1))
    const recurringKind =
      /assinatura|streaming|celular|internet|energia|[aá]gua|academia/i.test(list[0]!.merchantKind ?? '') ||
      /assinatura|contas|mensal/i.test(list[0]!.categoryName ?? '')
    if (recurringKind && monthly.length >= 2 && list.length === 1) {
      const last2 = monthly.slice(-2).map(([, v]) => v[0]!)
      const stable = Math.abs(last2[0]! - last2[1]!) <= last2[1]! * 0.02
      const cur = list[0]!.amountCents
      if (stable && Math.abs(cur - last2[1]!) > last2[1]! * 0.03) {
        issues.push({
          id: issueId('assinatura_mudou', [list[0]!.id]),
          type: 'assinatura_mudou',
          severity: cur > last2[1]! ? 'media' : 'baixa',
          title: `${list[0]!.merchant} mudou de valor: ${brl(last2[1]!)} → ${brl(cur)}`,
          detail: cur > last2[1]! ? 'Conta recorrente ficou mais cara. Foi reajuste combinado?' : 'Ficou mais barato que nos meses anteriores.',
          txIds: [list[0]!.id],
        })
      }
    }
  }

  // 8) Recorrente que sumiu (todo mês nos últimos 3, mas não neste)
  const last3 = [1, 2, 3].map((k) => shiftMonth(month, -k))
  const monthOver = month < today.slice(0, 7)
  const reportedMissing: ConsItem[] = []
  for (const [mk, past] of byMerchant) {
    if (!mk || expenses.some((t) => similarMerchant(t, past[0]!))) continue
    if (reportedMissing.some((r) => similarMerchant(r, past[0]!))) continue
    const per = last3.map((m) => past.filter((p) => monthOf(p.date) === m))
    if (!per.every((x) => x.length === 1)) continue
    const amts = per.map((x) => x[0]!.amountCents)
    if (Math.max(...amts) > Math.min(...amts) * 1.1) continue
    const usualDay = Math.round(median(per.map((x) => Number(x[0]!.date.slice(8)))))
    if (!monthOver && Number(today.slice(8)) <= usualDay + 5) continue
    const ref = per[0]![0]!
    reportedMissing.push(ref)
    issues.push({
      id: issueId('recorrente_ausente', [], `${month}:${mk}`),
      type: 'recorrente_ausente',
      severity: 'baixa',
      title: `${ref.merchant} não apareceu este mês`,
      detail: `Costuma vir todo mês por volta do dia ${usualDay} (${brl(ref.amountCents)}). Foi cancelado ou faltou importar a fatura/extrato?`,
      txIds: [],
    })
  }

  // 9) Conta/cartão que sempre tem lançamento e neste mês não tem nada
  const accountsNow = new Set(items.map((t) => t.account ?? ''))
  const last2 = [shiftMonth(month, -1), shiftMonth(month, -2)]
  const accountsHist = new Set(
    [...new Set(hist.map((t) => t.account ?? ''))].filter(
      (acc) => acc && last2.every((m) => hist.some((t) => (t.account ?? '') === acc && monthOf(t.date) === m)),
    ),
  )
  if (monthOver || Number(today.slice(8)) > 10) {
    for (const acc of accountsHist) {
      if (accountsNow.has(acc)) continue
      issues.push({
        id: issueId('conta_sem_lancamentos', [], `${month}:${acc}`),
        type: 'conta_sem_lancamentos',
        severity: 'media',
        title: `Nada de "${acc}" neste mês`,
        detail: 'Essa conta/cartão teve lançamentos nos meses anteriores. Faltou importar o extrato ou a fatura?',
        txIds: [],
      })
    }
  }

  // 10) Sem categoria
  const uncategorized = expenses.filter((t) => !t.categoryId)
  if (uncategorized.length) {
    const total = uncategorized.reduce((s, t) => s + t.amountCents, 0)
    issues.push({
      id: issueId('sem_categoria', [], month),
      type: 'sem_categoria',
      severity: total >= 50_000 ? 'media' : 'baixa',
      title: `${uncategorized.length} gasto(s) sem categoria (${brl(total)})`,
      detail: 'Escolha a categoria aqui mesmo; o app aprende para as próximas vezes.',
      txIds: uncategorized.map((t) => t.id),
    })
  }

  // Agrupamento por categoria + médias dos 3 meses anteriores
  const avgByCat = new Map<string, number>()
  for (const m of last3) {
    for (const t of histExp.filter((x) => monthOf(x.date) === m)) {
      const k = t.categoryId ?? '__none__'
      avgByCat.set(k, (avgByCat.get(k) ?? 0) + t.amountCents / 3)
    }
  }
  const histMonthsWithData = last3.filter((m) => hist.some((t) => monthOf(t.date) === m)).length

  const group = (list: ConsItem[], refunds: ConsItem[], withAvg: boolean): CategoryGroup[] => {
    const map = new Map<string, CategoryGroup>()
    const add = (t: ConsItem, sign: 1 | -1) => {
      const key = t.categoryId ?? '__none__'
      const g =
        map.get(key) ??
        ({
          key,
          categoryId: t.categoryId,
          name: t.categoryName ?? 'Sem categoria',
          totalCents: 0,
          count: 0,
          share: 0,
          avg3Cents: withAvg && histMonthsWithData >= 2 ? Math.round(avgByCat.get(key) ?? 0) : null,
          items: [],
        } satisfies CategoryGroup)
      g.totalCents += sign * t.amountCents
      g.count += 1
      g.items.push(t)
      map.set(key, g)
    }
    for (const t of list) add(t, 1)
    for (const t of refunds) add(t, -1)
    const total = [...map.values()].reduce((s, g) => s + Math.max(0, g.totalCents), 0) || 1
    return [...map.values()]
      .map((g) => ({ ...g, share: Math.max(0, g.totalCents) / total, items: g.items.sort((a, b) => (a.date < b.date ? 1 : -1)) }))
      .sort((a, b) => b.totalCents - a.totalCents)
  }

  const byCategory = group(expenses, cardRefunds, true)
  for (const g of byCategory) {
    if (g.categoryId && g.avg3Cents && g.avg3Cents > 0 && g.totalCents > g.avg3Cents * 1.5 && g.totalCents - g.avg3Cents > 15_000) {
      issues.push({
        id: issueId('categoria_acima', [], `${month}:${g.key}`),
        type: 'categoria_acima',
        severity: 'baixa',
        title: `${g.name} acima do normal: ${brl(g.totalCents)}`,
        detail: `Média dos 3 meses anteriores: ${brl(g.avg3Cents)} (+${Math.round((g.totalCents / g.avg3Cents - 1) * 100)}%).`,
        txIds: [],
      })
    }
  }

  const accMap = new Map<string, { account: string; expenseCents: number; incomeCents: number; count: number }>()
  for (const t of included) {
    const acc = t.account ?? 'Sem conta'
    const a = accMap.get(acc) ?? { account: acc, expenseCents: 0, incomeCents: 0, count: 0 }
    if (t.kind === 'debit') a.expenseCents += t.amountCents
    else if (isCard(t)) a.expenseCents -= t.amountCents
    else a.incomeCents += t.amountCents
    a.count++
    accMap.set(acc, a)
  }

  const sevRank: Record<Severity, number> = { alta: 0, media: 1, baixa: 2 }
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])

  return {
    month,
    dismissedCount: issues.filter((i) => dismissed.has(i.id)).length,
    included,
    excluded: [...excluded.values()],
    totals: { incomeCents, expenseCents, netCents: incomeCents - expenseCents },
    byCategory,
    incomeByCategory: group(realIncomes, [], false),
    byAccount: [...accMap.values()].sort((a, b) => b.expenseCents - a.expenseCents),
    issues: issues.filter((i) => !dismissed.has(i.id)),
  }
}
