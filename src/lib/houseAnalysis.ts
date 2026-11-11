/**
 * Análise da casa a partir das abas mensais da planilha + do extrato do banco.
 *   - por mês: quanto a casa custou (aluguel, cada conta, coletivos), quanto cada morador devia;
 *   - por morador: quanto pagou de aluguel em cada mês, quando entrou/saiu (trocas de moradores);
 *   - banco: Pix recebido de cada morador × TOTAL da linha dele na planilha;
 *   - contas: como cada conta (água, luz, internet…) varia mês a mês;
 *   - categorias dos gastos coletivos (mercado, limpeza, manutenção…).
 */
import { foldName, counterparty } from '@/lib/house'
import { tabToYm, type HouseSheet } from '@/lib/houseSheet'

export type MonthData = { tab: string; ym: string; label: string; sheet: HouseSheet }

/** Abas carregadas, da mais antiga para a mais nova. */
export function monthsFrom(sheets: Record<string, HouseSheet>): MonthData[] {
  return Object.values(sheets)
    .map((sheet) => ({ tab: sheet.tab, ym: tabToYm(sheet.tab) ?? '', label: sheet.label, sheet }))
    .filter((m) => m.ym)
    .sort((a, b) => (a.ym < b.ym ? -1 : 1))
}

/* ------------------------------------------------------------- nomes */

const first = (s: string) => foldName(s).split(' ')[0] ?? ''
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length]![b.length]!
}
/** Mesmo morador? "Luísa" × "LUISA S", "Alan" × "ALLAN D" (uma letra de diferença). */
export function sameName(sheetName: string, other: string): boolean {
  const a = first(sheetName)
  const b = first(other)
  if (!a || !b) return false
  if (a === b) return true
  return a.length >= 4 && b.length >= 4 && lev(a, b) <= 1
}
/** Nome canônico (primeiro nome, com maiúscula) para juntar o mesmo morador entre meses. */
export const personKey = (n: string) => {
  const f = first(n)
  return f ? f[0]!.toUpperCase() + f.slice(1) : n
}

/* ------------------------------------------------------------- contas */

const BILL_KINDS: { key: string; label: string; re: RegExp }[] = [
  { key: 'agua', label: 'Água', re: /agua|sanasa|sabesp|saneamento/ },
  { key: 'luz', label: 'Luz', re: /luz|energia|cpfl|enel|eletric/ },
  { key: 'internet', label: 'Internet', re: /internet|\bnet\b|vivo|claro|tim|oi fibra|fibra|wi.?fi|desktop/ },
  { key: 'gas', label: 'Gás', re: /\bgas\b|comgas|botij/ },
  { key: 'iptu', label: 'IPTU', re: /iptu/ },
  { key: 'condominio', label: 'Condomínio', re: /condom/ },
  { key: 'aluguel', label: 'Aluguel', re: /aluguel|lanza|imobili/ },
  { key: 'limpeza', label: 'Faxina / limpeza', re: /faxin|diarist|limpeza|nilde/ },
  { key: 'streaming', label: 'Streaming', re: /netflix|spotify|prime|disney|hbo|max\b|globoplay|youtube/ },
]
export function billKind(name: string): { key: string; label: string } {
  const n = foldName(name)
  const k = BILL_KINDS.find((b) => b.re.test(n))
  return k ? { key: k.key, label: k.label } : { key: `outro:${n}`, label: name.trim() }
}

/* ------------------------------------------------------------- gastos coletivos */

const COLLECTIVE_CATS: { label: string; re: RegExp }[] = [
  { label: 'Mercado', re: /mercad|supermerc|atacad|assai|dalben|carrefour|feira|hortifr|comida|cafe|acucar|leite|pao/ },
  { label: 'Limpeza e higiene', re: /limpez|detergent|sabao|amaciant|papel|vassour|rodo|esponja|desinfet|alvejant|lixo|saco/ },
  { label: 'Manutenção e reparos', re: /manutenc|conserto|reparo|encanad|eletricist|pintur|tinta|lampad|chuveiro|torneira|drywall|parafus|ferrament|obra/ },
  { label: 'Móveis e utensílios', re: /sofa|movel|moveis|mesa|cadeira|cama|colchao|panela|utensil|prato|copo|geladeira|fogao|microondas|maquina|eletrodom/ },
  { label: 'Gás e água mineral', re: /\bgas\b|botij|galao|agua mineral/ },
  { label: 'Festas e eventos', re: /festa|churras|aniver|cerveja|bebida|role/ },
  { label: 'Serviços', re: /faxin|diarist|servico|nilde|lavanderia|dedetiz/ },
]
export function collectiveCategory(text: string): string {
  const t = foldName(text)
  return COLLECTIVE_CATS.find((c) => c.re.test(t))?.label ?? 'Outros'
}

/* ------------------------------------------------------------- resumo do mês */

export type MonthSummary = {
  tab: string
  ym: string
  label: string
  residents: string[]
  totalDueCents: number
  rentCents: number
  bills: { kind: string; label: string; cents: number; status: string; vencimento: string }[]
  billsCents: number
  collectiveCents: number
  caixinhaCents: number
  acertosCents: number
  /** pizza do mês: aluguel + contas + categorias dos coletivos */
  slices: { label: string; cents: number }[]
}

export function summarizeMonth(m: MonthData): MonthSummary {
  const s = m.sheet
  const bills = (s.contas ?? []).map((c) => ({ kind: billKind(c.conta).key, label: billKind(c.conta).label, cents: c.valorCents, status: c.status, vencimento: c.vencimento }))
  const rentBill = bills.filter((b) => b.kind === 'aluguel').reduce((a, b) => a + b.cents, 0)
  const rentCents = rentBill || s.aluguelSumCents
  const otherBills = bills.filter((b) => b.kind !== 'aluguel')
  const collectives = s.coletivos ?? []
  const byCat = new Map<string, number>()
  byCat.set('Aluguel', rentCents)
  for (const b of otherBills) byCat.set(b.label, (byCat.get(b.label) ?? 0) + b.cents)
  // sem bloco de contas: usa as colunas por morador (água, luz, net, IPTU)
  if (!otherBills.length) {
    const sum = (k: 'aguaCents' | 'luzCents' | 'netCents' | 'iptuCents') => s.residents.reduce((a, r) => a + (r[k] ?? 0), 0)
    for (const [label, k] of [['Água', 'aguaCents'], ['Luz', 'luzCents'], ['Internet', 'netCents'], ['IPTU', 'iptuCents']] as const) {
      const v = sum(k)
      if (v) byCat.set(label, v)
    }
  }
  for (const c of collectives) {
    const cat = `Coletivo · ${collectiveCategory(`${c.oQue} ${c.obs}`)}`
    byCat.set(cat, (byCat.get(cat) ?? 0) + c.quantoCents)
  }
  const billsCents = [...byCat.entries()].filter(([k]) => k !== 'Aluguel' && !k.startsWith('Coletivo')).reduce((a, [, v]) => a + v, 0)
  return {
    tab: m.tab,
    ym: m.ym,
    label: m.label,
    residents: s.residents.map((r) => r.nome),
    totalDueCents: s.residents.reduce((a, r) => a + r.totalCents, 0),
    rentCents,
    bills: otherBills,
    billsCents,
    collectiveCents: collectives.reduce((a, c) => a + c.quantoCents, 0),
    caixinhaCents: s.residents.reduce((a, r) => a + r.caixinhaCents, 0),
    acertosCents: (s.acertos ?? []).reduce((a, c) => a + c.deveCents, 0),
    slices: [...byCat.entries()].filter(([, v]) => v > 0).map(([label, cents]) => ({ label, cents })).sort((a, b) => b.cents - a.cents),
  }
}

/* ------------------------------------------------------------- moradores ao longo dos meses */

export type PersonHistory = {
  key: string
  /** primeiro nome como está na planilha (com acento) */
  display: string
  names: string[]
  months: { ym: string; label: string; aluguelCents: number; totalCents: number; caixinhaCents: number }[]
  firstYm: string
  lastYm: string
  totalPaidCents: number
  avgTotalCents: number
  /** quanto essa pessoa pagou de gastos coletivos pela casa (somando os meses) */
  collectivePaidCents: number
}

export function peopleHistory(months: MonthData[]): { people: PersonHistory[]; changes: { ym: string; label: string; entered: string[]; left: string[] }[] } {
  const map = new Map<string, PersonHistory>()
  for (const m of months) {
    for (const r of m.sheet.residents) {
      const k = personKey(r.nome)
      const p = map.get(k) ?? { key: k, display: r.nome.trim().split(/\s+/)[0] ?? k, names: [], months: [], firstYm: m.ym, lastYm: m.ym, totalPaidCents: 0, avgTotalCents: 0, collectivePaidCents: 0 }
      if (!p.names.includes(r.nome)) p.names.push(r.nome)
      p.months.push({ ym: m.ym, label: m.label, aluguelCents: r.aluguelCents, totalCents: r.totalCents, caixinhaCents: r.caixinhaCents })
      p.lastYm = m.ym
      p.totalPaidCents += r.totalCents
      map.set(k, p)
    }
    for (const c of m.sheet.coletivos ?? []) {
      const k = personKey(c.quem)
      const p = map.get(k)
      if (p) p.collectivePaidCents += c.quantoCents
    }
  }
  for (const p of map.values()) p.avgTotalCents = Math.round(p.totalPaidCents / Math.max(1, p.months.length))
  const changes: { ym: string; label: string; entered: string[]; left: string[] }[] = []
  for (let i = 1; i < months.length; i++) {
    const prev = new Set(months[i - 1]!.sheet.residents.map((r) => personKey(r.nome)))
    const cur = new Set(months[i]!.sheet.residents.map((r) => personKey(r.nome)))
    const entered = [...cur].filter((k) => !prev.has(k))
    const left = [...prev].filter((k) => !cur.has(k))
    const disp = (k: string) => map.get(k)?.display ?? k
    if (entered.length || left.length) changes.push({ ym: months[i]!.ym, label: months[i]!.label, entered: entered.map(disp), left: left.map(disp) })
  }
  return { people: [...map.values()].sort((a, b) => (a.firstYm < b.firstYm ? -1 : 1)), changes }
}

/* ------------------------------------------------------------- contas ao longo dos meses */

export type BillSeries = {
  key: string
  label: string
  points: { ym: string; label: string; cents: number }[]
  avgCents: number
  minCents: number
  maxCents: number
  lastCents: number
  /** último mês × média dos anteriores (%) */
  lastVsAvgPct: number | null
}

export function billSeries(months: MonthData[]): BillSeries[] {
  const map = new Map<string, BillSeries>()
  for (const m of months) {
    const s = summarizeMonth(m)
    const entries = s.bills.length
      ? s.bills.map((b) => ({ key: b.kind, label: b.label, cents: b.cents }))
      : s.slices.filter((x) => x.label !== 'Aluguel' && !x.label.startsWith('Coletivo')).map((x) => ({ key: billKind(x.label).key, label: x.label, cents: x.cents }))
    const merged = new Map<string, { label: string; cents: number }>()
    for (const e of entries) merged.set(e.key, { label: e.label, cents: (merged.get(e.key)?.cents ?? 0) + e.cents })
    for (const [key, e] of merged) {
      const b = map.get(key) ?? { key, label: e.label, points: [], avgCents: 0, minCents: 0, maxCents: 0, lastCents: 0, lastVsAvgPct: null }
      b.points.push({ ym: m.ym, label: m.label, cents: e.cents })
      map.set(key, b)
    }
  }
  for (const b of map.values()) {
    const v = b.points.map((p) => p.cents)
    b.avgCents = Math.round(v.reduce((a, x) => a + x, 0) / v.length)
    b.minCents = Math.min(...v)
    b.maxCents = Math.max(...v)
    b.lastCents = v[v.length - 1]!
    const prev = v.slice(0, -1)
    const prevAvg = prev.length ? prev.reduce((a, x) => a + x, 0) / prev.length : 0
    b.lastVsAvgPct = prevAvg ? Math.round(((b.lastCents - prevAvg) / prevAvg) * 100) : null
  }
  return [...map.values()].filter((b) => b.points.length).sort((a, b) => b.avgCents - a.avgCents)
}

/* ------------------------------------------------------------- planilha × banco */

export type BankTx = { id: string; date: string; amount_cents: number; kind: 'debit' | 'credit'; description_raw: string }
export type Reconciliation = {
  ym: string
  label: string
  rows: { nome: string; dueCents: number; paidCents: number; txs: BankTx[]; status: 'ok' | 'falta' | 'a_mais' | 'sem_pix' }[]
  dueCents: number
  receivedCents: number
  rentPaidCents: number
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Para a aba do mês M (aluguel pago entre 10 e 15/M), os Pix de cada morador entre o dia 15 de M−1
 * e o dia 25 de M. Você (a sua linha) fica de fora: não manda Pix para si mesmo.
 */
export function reconcileMonth(m: MonthData, txs: BankTx[], selfName: string | null, payeeRe: RegExp): Reconciliation {
  const from = addDays(`${m.ym}-15`, -31)
  const to = `${m.ym}-25`
  const inWindow = txs.filter((t) => t.date >= from && t.date <= to)
  const used = new Set<string>()
  const rows = m.sheet.residents
    .filter((r) => !selfName || !sameName(r.nome, selfName))
    .map((r) => {
      const mine = inWindow.filter((t) => t.kind === 'credit' && !used.has(t.id) && sameName(r.nome, counterparty(t.description_raw)))
      mine.forEach((t) => used.add(t.id))
      const paid = mine.reduce((a, t) => a + t.amount_cents, 0)
      const diff = paid - r.totalCents
      const status: Reconciliation['rows'][number]['status'] = !mine.length ? 'sem_pix' : Math.abs(diff) <= 100 ? 'ok' : diff < 0 ? 'falta' : 'a_mais'
      return { nome: r.nome, dueCents: r.totalCents, paidCents: paid, txs: mine, status }
    })
  const rentPaidCents = inWindow.filter((t) => t.kind === 'debit' && payeeRe.test(foldName(t.description_raw))).reduce((a, t) => a + t.amount_cents, 0)
  return {
    ym: m.ym,
    label: m.label,
    rows,
    dueCents: rows.reduce((a, r) => a + r.dueCents, 0),
    receivedCents: rows.reduce((a, r) => a + r.paidCents, 0),
    rentPaidCents,
  }
}
