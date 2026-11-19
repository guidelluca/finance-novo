/**
 * Parcelas do cartão mês a mês.
 * Cada parcela conta como saída no mês em que é cobrada:
 *  - se o banco manda todas as parcelas com a data da compra (ex.: 1/3, 2/3 e 3/3 em 24/10),
 *    a parcela j passa a valer no mês da compra + (j − 1);
 *  - as parcelas que ainda não vieram do banco entram como "previstas" nos meses seguintes
 *    e somem sozinhas quando a parcela de verdade chega.
 */
export type SchedTx = { id: string; date: string; amountCents: number; kind: 'debit' | 'credit'; description: string; account: string | null }

export const PARC_RE = /\s*\(?\s*(?:parcela\s*|parc\s*)(\d{1,2})\s*\/\s*(\d{1,2})\s*\)?/i
const CARD = /cart[aã]o|cr[eé]dito/i

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const first = new Date(Date.UTC(y!, m! - 1 + n, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d!, last)).padStart(2, '0')}`
}

export function parseInstallment(desc: string): { n: number; of: number; base: string } | null {
  const m = desc.match(PARC_RE)
  if (!m) return null
  const n = Number(m[1])
  const of = Number(m[2])
  if (!n || of < 2 || n > of || of > 48) return null
  return { n, of, base: desc.replace(PARC_RE, ' ').replace(/\s+·\s+(pendente|prevista)\b/gi, '').replace(/\s+/g, ' ').trim() }
}

export type Projected<T extends SchedTx> = { key: string; date: string; n: number; of: number; source: T; base: string }

export function scheduleInstallments<T extends SchedTx>(all: T[]): { effDate: Map<string, string>; projected: Projected<T>[] } {
  const groups = new Map<string, { base: string; rows: { t: T; n: number }[]; of: number }>()
  for (const t of all) {
    if (t.kind !== 'debit' || !CARD.test(t.account ?? '')) continue
    const p = parseInstallment(t.description)
    if (!p) continue
    const key = `${fold(t.account ?? '')}|${fold(p.base)}|${p.of}|${Math.round(t.amountCents / 100)}`
    const g = groups.get(key) ?? { base: p.base, rows: [], of: p.of }
    if (!g.rows.some((r) => r.n === p.n)) g.rows.push({ t, n: p.n })
    groups.set(key, g)
  }
  const effDate = new Map<string, string>()
  const projected: Projected<T>[] = []
  for (const [key, g] of groups) {
    const purchaseDated = g.rows.length > 1 && new Set(g.rows.map((r) => r.t.date)).size === 1
    for (const r of g.rows) effDate.set(r.t.id, purchaseDated ? addMonthsIso(r.t.date, r.n - 1) : r.t.date)
    const top = g.rows.reduce((a, b) => (b.n > a.n ? b : a))
    const seen = new Set(g.rows.map((r) => r.n))
    for (let j = top.n + 1; j <= g.of; j++) {
      if (seen.has(j)) continue
      const date = purchaseDated ? addMonthsIso(top.t.date, j - 1) : addMonthsIso(top.t.date, j - top.n)
      projected.push({ key: `${key}|${j}`, date, n: j, of: g.of, source: top.t, base: g.base })
    }
  }
  return { effDate, projected }
}
