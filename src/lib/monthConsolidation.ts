/**
 * Extrato consolidado do mês: junta todas as contas e cartões, tira repetições,
 * separa o que não é gasto (pagamento de fatura, transferência entre contas, investimento),
 * agrupa por categoria e aponta o que merece revisão.
 *
 * Sem dependências externas (testável isoladamente). Nada é apagado aqui: só classifica.
 */
import { caixinhaShare, classifyHouse, residentOf, selfResident, type HouseConfig } from '@/lib/house'
import { sheetTabForPayment, type SheetResident } from '@/lib/houseSheet'
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

export type ConsItem = ConsTx & {
  merchant: string
  merchantKey: string
  merchantKind: string | null
  /** categorias que o estabelecimento costuma ter (dicionário local) */
  expectedCategories: string[]
  ruleKey: string | null
}

export type ExcludedReason = 'duplicada' | 'pagamento_fatura' | 'transferencia_interna' | 'investimento' | 'estorno' | 'linha_invalida' | 'casa' | 'valor_improvavel'

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
  | 'estorno'
  | 'categoria_suspeita'
  | 'linha_invalida'
  | 'valor_improvavel'

export type Severity = 'alta' | 'media' | 'baixa'

export type Issue = {
  /** estável: permite "marcar como visto" */
  id: string
  type: IssueType
  severity: Severity
  title: string
  detail: string
  txIds: string[]
  /** categoria_suspeita: nomes de categoria que fariam sentido (a tela escolhe a do usuário) */
  suggestNames?: string[]
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
  /** aluguel pago à imobiliária: só a sua parte (total − o que os moradores mandaram) conta como gasto seu */
  rentShares: RentShare[]
}

export type RentShare = {
  txId: string
  date: string
  paidCents: number
  receivedCents: number
  /** aluguel − Pix dos moradores (antes da caixinha) */
  rentPartCents: number
  /** caixinha do mês ÷ moradores, somada à sua parte (só no 1.º aluguel do mês) */
  caixinhaCents: number
  caixinhaTotalCents: number
  /** o que conta como gasto seu: parte do aluguel + parte da caixinha */
  shareCents: number
  from: { who: string; cents: number; date: string; txId: string }[]
  /** aba da planilha que confere com este aluguel (mês anterior ao pagamento) */
  sheetTab: string
  /** planilha lida: sua linha e o que cada morador deveria ter mandado */
  sheet: {
    tab: string
    label: string
    fetchedAt: string
    me: SheetResident
    members: { who: string; nome: string | null; expectedCents: number | null; paidCents: number }[]
    aluguelSumCents: number
  } | null
}

/** Pix de morador abaixo disso é caixinha/rateio de conta, não aluguel */
export const RENT_PIX_MIN = 30_000

const SOURCE_PRIORITY: Record<TxSource, number> = { fatura: 5, extrato: 4, csv: 3, print: 2, manual: 1 }

const CARD_PAYMENT =
  /fatura paga|pagamento (de |da )?fatura|pgto\.? ?fatura|pag(to|amento)? (de )?cart[aã]o|fatura (do |de )?cart[aã]o|itaucard|nu ?pagamentos|pagamento.*\b(nubank|picpay card|cart[aã]o)\b|d[eé]bito autom[aá]tico.*fatura/i
const INVESTMENT =
  /\b(aplica[cç][aã]o|resgate|rdb|cdb|lci|lca|tesouro direto|poupan[cç]a|caixinha|cofrinho|porquinho|investimento|guardado|guardar dinheiro)\b/i
/** Teto plausível de um único lançamento por tipo de gasto (acima disso, provavelmente erro de leitura). */
const PLAUSIBLE_MAX: { re: RegExp; max: number; what: string }[] = [
  { re: /autopass|[oô]nibus|metr[oô]\b|via[cç][aã]o|bilhete [uú]nico|sptrans|cptm|emtu|transporte p[uú]blico/i, max: 15_000, what: 'uma passagem ou recarga de transporte' },
  { re: /\buber\b|^99\b|99 \(corrida\)|\bcabify\b|indrive|corrida/i, max: 30_000, what: 'uma corrida de app' },
  { re: /ifood|99food|rappi|z[eé] delivery|delivery/i, max: 40_000, what: 'um pedido de delivery' },
  { re: /netflix|spotify|disney|hbo|prime video|youtube|deezer|globoplay|apple\.com|icloud|streaming/i, max: 15_000, what: 'uma assinatura de streaming' },
  { re: /padaria|lanchonete|\bcaf[eé]\b|sorvet|a[cç]a[ií]/i, max: 25_000, what: 'uma compra em padaria ou lanchonete' },
  { re: /estacionamento|ped[aá]gio|sem parar|conectcar|veloe/i, max: 20_000, what: 'estacionamento ou pedágio' },
  { re: /^iof\b|\btarifa\b|anuidade/i, max: 30_000, what: 'uma tarifa ou IOF' },
]

const SELF_TRANSFER = /conta pr[oó]pria|mesma titularidade/i
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const TRANSFER_HINT = /\b(pix|transf|transfer[eê]ncia|ted|doc)\b/i
const FEE = /\b(anuidade|tarifa|juros|multa|encargo|mora|iof|cesta de servi[cç]os|pacote de servi[cç]os)\b/i
const APP_RIDE = /uber|\b99\b|99 \(|cabify|indrive/i

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000)
}


function shiftIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
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
  // categorias vindas só do tipo de operação (Pix/TED para pessoa) não dizem nada do gasto
  const opOnly = m.categories.every((c) => c === 'Pix' || c === 'Transferências')
  return {
    ...t,
    merchant: name,
    merchantKey: keyOf(name),
    merchantKind: m.kind,
    expectedCategories: opOnly ? [] : m.categories,
    ruleKey: m.ruleKey,
  }
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
  /** nome do titular (do cabeçalho do extrato): Pix para esse nome = entre suas contas */
  ownerName: string | null = null,
  /** mês financeiro (começa no salário); sem isso, mês do calendário */
  periodOf: (date: string) => string = (d) => d.slice(0, 7),
  /** finanças da casa (república): aluguel, Pix dos moradores, caixinha — fora dos totais pessoais */
  house: HouseConfig | null = null,
): ConsolidatedMonth {
  const monthOf = periodOf
  const items = monthTxs.filter((t) => monthOf(t.date) === month).map(enrich)
  const hist = history.filter((t) => monthOf(t.date) < month).map(enrich)
  const issues: Issue[] = []
  const excluded = new Map<string, Excluded>()
  const exclude = (tx: ConsItem, reason: ExcludedReason, note: string, relatedId?: string) => {
    if (!excluded.has(tx.id)) excluded.set(tx.id, { tx, reason, note, relatedId })
  }

  // 1) Investimentos (aplicação/resgate) não são gasto nem receita
  for (const t of items) {
    if (INVESTMENT.test(t.description)) exclude(t, 'investimento', t.kind === 'debit' ? 'Aplicação' : 'Resgate')
  }

  // 0) Linha do extrato que não é lançamento (saldo, cabeçalho da tabela) gravada por engano
  const INVALID_LINE = /^saldo (do dia|anterior|total|final|em conta)\b|^saldo\s*$|^data\s+lan[cç]amentos?\b|lan[cç]amentos\s+saldo|valor\s*\(r\$\)/i
  const invalid = items.filter((t) => INVALID_LINE.test(t.description.trim()))
  for (const t of invalid) exclude(t, 'linha_invalida', 'Linha de saldo ou cabeçalho do extrato, não é um lançamento')
  if (invalid.length) {
    issues.push({
      id: issueId('linha_invalida', invalid.map((t) => t.id)),
      type: 'linha_invalida',
      severity: 'alta',
      title: `${invalid.length} linha(s) de saldo/cabeçalho gravadas como lançamento`,
      detail:
        'Vieram de uma importação antiga do extrato (ex.: “Saldo do Dia”). Já tirei da soma; apague-as. Se o extrato for do Itaú, importe-o de novo: os valores das outras linhas também podem estar trocados.',
      txIds: invalid.map((t) => t.id),
    })
  }

  // 0b) Dinheiro da casa (você é o tesoureiro): não é renda nem gasto seu
  for (const t of items) {
    if (excluded.has(t.id)) continue
    const h = classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house)
    if (h?.kind === 'casa') {
      const why = h.why === 'pagamento' ? `pagamento da casa (${h.who})` : h.why === 'caixinha' ? 'caixinha da casa' : h.why === 'manual' ? 'marcado como da casa' : `${t.kind === 'credit' ? 'recebido de' : 'enviado para'} ${h.who}`
      exclude(t, 'casa', `Da casa: ${why}`)
    }
  }

  // 0c) Aluguel. Duas fontes, uma confere a outra:
  //     - planilha da casa (aba do mês do pagamento; aluguel pago entre 10 e 15): seu gasto = Aluguel + Caixinha da SUA linha,
  //       e cada morador deve ter mandado o TOTAL da linha dele;
  //     - banco: R$ 4.316 para a Lanza − Pix dos moradores (+ caixinha digitada à mão) = sua parte.
  //     Com a planilha lida, ela manda; o banco vira conferência.
  const rentShares: RentShare[] = []
  if (house) {
    const pool = [...hist, ...items]
      .filter((t) => t.kind === 'credit')
      .map((t) => ({ t, h: classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house) }))
      .filter((x) => x.h?.kind === 'casa' && (x.h.why === 'morador' || x.h.why === 'manual'))
    const used = new Set<string>()
    const payments = items
      .filter((t) => t.kind === 'debit' && excluded.get(t.id)?.reason === 'casa')
      .filter((t) => classifyHouse({ id: t.id, description: t.description, kind: t.kind }, house)?.why === 'pagamento')
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    for (const pay of payments) {
      const tab = sheetTabForPayment(pay.date)
      const sheet = house.sheets?.[tab] ?? null
      // Pix dos moradores de até 25 dias antes a 10 dias depois do pagamento.
      // Sem planilha: um Pix por morador, a partir de R$ 300 (menores são caixinha).
      // Com planilha: soma todos os Pix de cada morador (pode ter pago em partes) para comparar com o TOTAL dele.
      const from: RentShare['from'] = []
      const seenWho = new Set<string>()
      const cands = pool
        .filter(({ t }) => !used.has(t.id) && dayDiff(t.date, pay.date) <= 25 && t.date <= shiftIso(pay.date, 10))
        .filter(({ t }) => sheet || t.amountCents >= RENT_PIX_MIN)
        .sort((a, b) => dayDiff(a.t.date, pay.date) - dayDiff(b.t.date, pay.date))
      for (const { t, h } of cands) {
        if (!sheet && seenWho.has(h!.who)) continue
        seenWho.add(h!.who)
        used.add(t.id)
        from.push({ who: h!.who, cents: t.amountCents, date: t.date, txId: t.id })
      }
      const receivedCents = from.reduce((a, x) => a + x.cents, 0)
      const rentPartCents = pay.amountCents - receivedCents

      let shareCents: number
      let cxCents = 0
      let cxTotal = 0
      let sheetCheck: RentShare['sheet'] = null
      const me = sheet ? selfResident(sheet.residents, house, ownerName) : null
      if (sheet && me && rentShares.every((r) => r.sheet?.tab !== tab)) {
        shareCents = me.aluguelCents + me.caixinhaCents
        cxCents = me.caixinhaCents
        const members = house.members.map((m) => {
          const row = residentOf(m, sheet.residents)
          return {
            who: m,
            nome: row?.nome ?? null,
            expectedCents: row?.totalCents ?? null,
            paidCents: from.filter((f) => f.who === m).reduce((a, f) => a + f.cents, 0),
          }
        })
        sheetCheck = { tab, label: sheet.label, fetchedAt: sheet.fetchedAt, me, members, aluguelSumCents: sheet.aluguelSumCents }
      } else {
        // caixinha do mês digitada à mão, dividida entre os moradores (uma vez por mês)
        const cx = rentShares.length === 0 ? caixinhaShare(house, month) : { totalCents: 0, shareCents: 0 }
        cxCents = cx.shareCents
        cxTotal = cx.totalCents
        shareCents = rentPartCents + cx.shareCents
      }
      rentShares.push({
        txId: pay.id,
        date: pay.date,
        paidCents: pay.amountCents,
        receivedCents,
        rentPartCents,
        caixinhaCents: cxCents,
        caixinhaTotalCents: cxTotal,
        shareCents,
        from,
        sheetTab: tab,
        sheet: sheetCheck,
      })
      if (shareCents > 0) {
        // entra nos seus gastos só a sua parte, como aluguel
        excluded.delete(pay.id)
        const idx = items.indexOf(pay)
        items[idx] = { ...pay, amountCents: shareCents }
      }
    }
  }

  // 1b) Pix/TED para você mesmo (o leitor do extrato marca "conta própria" pelo nome do titular)
  const ownName = ownerName ? fold(ownerName) : null
  const isSelf = (desc: string) =>
    SELF_TRANSFER.test(desc) || Boolean(ownName && ownName.includes(' ') && TRANSFER_HINT.test(desc) && fold(desc).includes(ownName))
  for (const t of items) {
    if (excluded.has(t.id) || !isSelf(t.description)) continue
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
    // nomes diferentes: só considera se for até 1 dia
    if (!strong && dayDiff(a.date, b.date) > 1) continue
    const [keep, drop] = SOURCE_PRIORITY[a.source] >= SOURCE_PRIORITY[b.source] ? [a, b] : [b, a]
    const id = issueId('duplicada', [keep.id, drop.id])
    if (dismissed.has(id)) continue // usuário confirmou: são 2 lançamentos, os dois contam
    paired.add(a.id)
    paired.add(b.id)
    exclude(
      drop,
      'duplicada',
      `${strong ? 'Repetida' : 'Possível repetida'} de ${keep.merchant} (${keep.account ?? keep.source}, ${keep.date.slice(8)}/${keep.date.slice(5, 7)}). Não está contando até você confirmar.`,
      keep.id,
    )
    issues.push({
      id,
      type: 'duplicada',
      severity: strong ? 'media' : 'baixa',
      title: `${strong ? 'Repetida' : 'Possível repetida'}: ${keep.merchant} · ${brl(keep.amountCents)}`,
      detail: strong
        ? `Aparece em duas importações (${keep.account ?? keep.source} e ${drop.account ?? drop.source}). Contei uma vez só. Se forem dois lançamentos de verdade, toque em "Não é repetida".`
        : `Mesmo valor e data em ${keep.account ?? keep.source} e ${drop.account ?? drop.source}, com nomes diferentes (${keep.merchant} × ${drop.merchant}). Deixei só um contando até você confirmar.`,
      txIds: [keep.id, drop.id],
    })
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

  // 4b) O outro lado de um Pix para você mesmo (ex.: saiu do Itaú "conta própria", entrou no Nubank)
  for (const t of items) {
    if (excluded.has(t.id)) continue
    const mirror = items.find(
      (x) =>
        excluded.get(x.id)?.reason === 'transferencia_interna' &&
        !excluded.get(x.id)?.relatedId &&
        x.kind !== t.kind &&
        x.amountCents === t.amountCents &&
        x.account !== t.account &&
        dayDiff(x.date, t.date) <= 1,
    )
    if (!mirror) continue
    exclude(t, 'transferencia_interna', t.kind === 'credit' ? `Veio de ${mirror.account}` : `Foi para ${mirror.account}`, mirror.id)
    excluded.get(mirror.id)!.relatedId = t.id
  }

  // 4c) Estorno: compra/corrida cancelada e o dinheiro devolvido logo depois → as duas saem da soma
  const REFUND_HINT = /estorno|estornad|cancel|reembols|devolu|chargeback/i
  const debitsLive = items.filter((t) => t.kind === 'debit' && !excluded.has(t.id))
  for (const c of items) {
    if (c.kind !== 'credit' || excluded.has(c.id)) continue
    const ride = APP_RIDE.test(c.merchant + ' ' + c.description)
    const hinted = REFUND_HINT.test(c.description)
    const d = debitsLive
      .filter(
        (x) =>
          !excluded.has(x.id) &&
          x.amountCents === c.amountCents &&
          x.date <= c.date &&
          dayDiff(x.date, c.date) <= (ride ? 3 : 10) &&
          (x.account === c.account || (isCard(x) && isCard(c))) &&
          (similarMerchant(x, c) || (ride && APP_RIDE.test(x.merchant + ' ' + x.description)) || hinted),
      )
      .sort((a, b) => dayDiff(a.date, c.date) - dayDiff(b.date, c.date))[0]
    if (!d) continue
    const id = issueId('estorno', [d.id, c.id])
    if (dismissed.has(id)) continue
    const label = ride ? 'Corrida cancelada e estornada' : 'Compra estornada'
    exclude(d, 'estorno', `${label}: o valor voltou em ${c.date.slice(8)}/${c.date.slice(5, 7)}`, c.id)
    exclude(c, 'estorno', `${label}: devolução da cobrança de ${d.date.slice(8)}/${d.date.slice(5, 7)}`, d.id)
    issues.push({
      id,
      type: 'estorno',
      severity: 'baixa',
      title: `${label}: ${d.merchant} · ${brl(d.amountCents)}`,
      detail: 'Cobrança e devolução do mesmo valor. Tirei as duas de entradas e saídas. Se não for estorno, toque em "Não é estorno".',
      txIds: [d.id, c.id],
    })
  }

  // 4d) Análise crítica: valor que não faz sentido para o tipo de gasto (ex.: R$ 2.731 no Autopass)
  //     fica fora da soma até você confirmar — geralmente é leitura errada do extrato
  for (const t of items) {
    if (excluded.has(t.id) || t.kind !== 'debit') continue
    const hay = `${t.merchant} ${t.merchantKind ?? ''} ${t.description}`
    const rule = PLAUSIBLE_MAX.find((r) => r.re.test(hay))
    if (!rule || t.amountCents <= rule.max) continue
    const id = issueId('valor_improvavel', [t.id])
    if (dismissed.has(id)) continue
    exclude(t, 'valor_improvavel', `Valor alto demais para ${rule.what}. Fora da soma até você confirmar.`)
    issues.push({
      id,
      type: 'valor_improvavel',
      severity: 'alta',
      title: `${brl(t.amountCents)} em ${t.merchant}?`,
      detail: `É muito para ${rule.what} (costuma ser até ${brl(rule.max)}). Pode ter sido lido errado do extrato: confira o valor no app do banco e corrija, ou importe o arquivo de novo. Deixei fora da soma até você confirmar.`,
      txIds: [t.id],
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
  const monthOver = month < monthOf(today)
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

  // 9b) Categoria que não combina com o estabelecimento (ex.: Mercado Livre em "VR", Posto em "Restaurantes")
  const foldCat = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const catFits = (cat: string, expected: string[]) => {
    const c = foldCat(cat)
    return expected.some((e) => {
      const f = foldCat(e)
      return c.includes(f) || f.includes(c)
    })
  }
  const suspicious = new Map<string, ConsItem[]>()
  for (const t of items) {
    if (excluded.has(t.id) || !t.categoryId || !t.categoryName || t.expectedCategories.length === 0) continue
    if (catFits(t.categoryName, t.expectedCategories)) continue
    const k = `${t.ruleKey ?? t.merchantKey}:${t.categoryId}`
    suspicious.set(k, [...(suspicious.get(k) ?? []), t])
  }
  for (const [k, group] of suspicious) {
    const t = group[0]!
    // sem o mês no id: "está certo" vale para sempre para esse estabelecimento + categoria
    const id = issueId('categoria_suspeita', [], k)
    if (dismissed.has(id)) continue
    issues.push({
      id,
      type: 'categoria_suspeita',
      severity: 'baixa',
      title: `${t.merchant} em “${t.categoryName}”?`,
      detail: `${group.length > 1 ? `${group.length} lançamentos` : 'Esse lançamento'} de ${t.merchant} ${group.length > 1 ? 'estão' : 'está'} em “${t.categoryName}”, mas costuma ser ${t.expectedCategories.slice(0, 2).join(' ou ')}. Mude ou confirme que está certo.`,
      txIds: group.map((g) => g.id),
      suggestNames: t.expectedCategories,
    })
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
    rentShares,
    issues: issues.filter((i) => !dismissed.has(i.id)),
  }
}
