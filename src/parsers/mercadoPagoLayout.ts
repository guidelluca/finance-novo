import { parseBrazilianDate, parseMoneyToCents } from '@/lib/currency'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

type Item = { x: number; y: number; w: number; str: string }
type Page = { width: number; height: number; items: Item[] }

const DATE = /^(\d{2})-(\d{2})-(\d{4})$/
const MONEY = /^R\$\s?-?\s?\d{1,3}(?:\.\d{3})*,\d{2}$/

const money = (s: string): number | null => {
  const neg = /-/.test(s)
  const c = parseMoneyToCents(s.replace(/R\$|\s|-/g, ''))
  return c == null ? null : neg ? -c : c
}

/**
 * Extrato de conta Mercado Pago (PDF "EXTRATO DE CONTA · DETALHE DOS MOVIMENTOS"):
 * Data | Descrição (às vezes em 2 linhas, acima e abaixo da data) | ID da operação | Valor | Saldo.
 * Cada pedaço de descrição vai para a linha de data mais próxima; confere pelo saldo após cada movimento.
 */
export function parseMercadoPagoLayout(pages: Page[]): ParseResult & { holderName?: string | null } {
  const warnings: string[] = []
  const drafts: TransactionDraft[] = []
  const saldos: { cents: number; saldo: number | null }[] = []
  let holderName: string | null = null

  for (const page of pages) {
    const items = page.items.map((i) => ({ ...i, str: i.str.trim() })).filter((i) => i.str)
    const header = items.find((i) => /^ID da opera/i.test(i.str))
    const descHead = items.find((i) => /^Descri[cç][aã]o$/i.test(i.str))
    if (!holderName) {
      const cpf = items.find((i) => /^CPF\/CNPJ/i.test(i.str))
      if (cpf) {
        const above = items
          .filter((i) => Math.abs(i.y - cpf.y) > 4 && Math.abs(i.y - cpf.y) < 30 && /^[A-Za-zÀ-ÿ ]{6,}$/.test(i.str) && !/extrato/i.test(i.str))
          .sort((a, b) => Math.abs(a.y - cpf.y) - Math.abs(b.y - cpf.y))[0]
        holderName = above?.str ?? null
      }
    }
    const top = items.find((i) => /^EXTRATO DE CONTA$/i.test(i.str))
    const bottom = items.find((i) => /^Data de gera/i.test(i.str))
    const topDown = top && bottom ? top.y < bottom.y : false
    const dates = items.filter((i) => DATE.test(i.str) && (!descHead || i.x < descHead.x))
    if (dates.length === 0) continue
    const idX = header?.x ?? Infinity
    const descX = descHead ? descHead.x - 8 : Math.max(...dates.map((d) => d.x + d.w))
    const rows = dates.map((d) => ({ d, desc: [] as Item[], money: [] as Item[] }))
    const nearest = (it: Item) => rows.reduce((best, r) => (Math.abs(r.d.y - it.y) < Math.abs(best.d.y - it.y) ? r : best), rows[0]!)
    for (const it of items) {
      if (DATE.test(it.str) && rows.some((r) => r.d === it)) continue
      const r = nearest(it)
      if (Math.abs(r.d.y - it.y) > 22) continue
      if (MONEY.test(it.str)) r.money.push(it)
      else if (it.x >= descX && it.x < idX - 4) r.desc.push(it)
    }
    for (const r of rows) {
      const m = [...r.money].sort((a, b) => a.x - b.x)
      const cents = m[0] ? money(m[0].str) : null
      if (cents == null || cents === 0) continue
      const [dd, mm, yyyy] = r.d.str.split('-')
      const date = parseBrazilianDate(`${dd}/${mm}/${yyyy}`)
      if (!date) continue
      // ordem de leitura de cima para baixo (alguns PDFs têm o eixo y invertido)
      const desc = [...r.desc]
        .sort((a, b) => (Math.abs(a.y - b.y) > 2 ? (topDown ? a.y - b.y : b.y - a.y) : a.x - b.x))
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      drafts.push({
        tempId: `mpl-${drafts.length + 1}`,
        date,
        amountCents: Math.abs(cents),
        kind: cents < 0 ? 'debit' : 'credit',
        descriptionRaw: desc || 'Movimento Mercado Pago',
        accountHint: 'Mercado Pago',
      })
      saldos.push({ cents, saldo: m[1] ? money(m[1].str) : null })
    }
  }

  // ordem do documento pode vir invertida no eixo y: ordena por data
  const withSaldo = saldos.filter((s) => s.saldo !== null)
  const ok = (seq: typeof withSaldo) => seq.every((s, i) => i === 0 || s.saldo === seq[i - 1]!.saldo! + s.cents)
  if (drafts.length === 0) warnings.push('Não encontrei movimentos no extrato do Mercado Pago (Data · Descrição · Valor · Saldo).')
  else if (withSaldo.length >= 2 && (ok(withSaldo) || ok([...withSaldo].reverse())))
    warnings.push(`Conferido: os ${drafts.length} movimentos batem com o saldo após cada um.`)
  return { drafts, warnings, holderName }
}
