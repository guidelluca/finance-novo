import { parseBrazilianDate, parseMoneyToCents } from '@/lib/currency'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

/** Extrato da conta Banco Inter: CSV ("Data Lançamento;Histórico;Descrição;Valor;Saldo") e PDF. */

type Page = { width: number; height: number; items: { x: number; y: number; w: number; str: string }[] }
type Row = { date: string; desc: string; cents: number; saldo: number | null }

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
}

export function looksLikeInterCsv(text: string): boolean {
  const head = text.slice(0, 1500)
  return /data lan[cç]amento\s*;\s*hist[oó]rico\s*;\s*descri[cç][aã]o\s*;\s*valor/i.test(head)
}

export function looksLikeInterPdf(text: string): boolean {
  const head = text.slice(0, 3000)
  return /institui[cç][aã]o:\s*banco inter|banco inter s\.?a|\binter\b.*saldo por transa[cç][aã]o/i.test(head) || /saldo por transa[cç][aã]o/i.test(head)
}

/** Saldo após cada transação permite conferir: em algum sentido, saldo[i] = saldo[i−1] + valor[i]. */
function checkRunningBalance(rows: Row[]): string | null {
  const withSaldo = rows.filter((r) => r.saldo !== null)
  if (withSaldo.length < 2) return null
  const ok = (seq: Row[]) => seq.every((r, i) => i === 0 || r.saldo === seq[i - 1]!.saldo! + r.cents)
  if (ok(withSaldo) || ok([...withSaldo].reverse())) {
    return `Conferido: os ${rows.length} lançamentos batem com o saldo após cada transação.`
  }
  return 'Atenção: o saldo após cada transação não fecha com os valores lidos. Confira o extrato antes de salvar.'
}

function toDrafts(rows: Row[], prefix: string): TransactionDraft[] {
  return rows.map((r, i) => ({
    tempId: `${prefix}-${i + 1}`,
    date: r.date,
    amountCents: Math.abs(r.cents),
    kind: r.cents < 0 ? 'debit' : 'credit',
    descriptionRaw: r.desc.slice(0, 500) || 'Lançamento Inter',
    accountHint: 'Banco Inter',
  }))
}

export function parseInterCsv(text: string): ParseResult & { holderName?: string | null } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const hi = lines.findIndex((l) => /data lan[cç]amento\s*;/i.test(l))
  const warnings: string[] = []
  if (hi < 0) return { drafts: [], warnings: ['Não achei o cabeçalho "Data Lançamento;Histórico;Descrição;Valor;Saldo".'] }
  const cols = lines[hi]!.split(';').map((c) => c.trim().toLowerCase())
  const iDate = cols.findIndex((c) => c.startsWith('data'))
  const iHist = cols.findIndex((c) => c.startsWith('hist'))
  const iDesc = cols.findIndex((c) => c.startsWith('descri'))
  const iVal = cols.findIndex((c) => c.startsWith('valor'))
  const iSaldo = cols.findIndex((c) => c.startsWith('saldo'))
  const rows: Row[] = []
  let bad = 0
  for (const line of lines.slice(hi + 1)) {
    if (!line.trim()) continue
    const c = line.split(';')
    const date = parseBrazilianDate((c[iDate] ?? '').trim())
    const cents = parseMoneyToCents((c[iVal] ?? '').trim())
    if (!date || cents == null || cents === 0) {
      bad += 1
      continue
    }
    const hist = (c[iHist] ?? '').trim()
    const desc = (c[iDesc] ?? '').trim()
    rows.push({
      date,
      desc: hist && desc ? `${hist}: ${desc}` : hist || desc,
      cents,
      saldo: iSaldo >= 0 ? parseMoneyToCents((c[iSaldo] ?? '').trim()) : null,
    })
  }
  if (bad) warnings.push(`${bad} linha(s) sem data ou valor foram ignoradas.`)
  const check = checkRunningBalance(rows)
  if (check) warnings.push(check)
  if (rows.length === 0) warnings.push('Nenhum lançamento encontrado no CSV do Inter.')
  return { drafts: toDrafts(rows, 'intercsv'), warnings }
}

/** Algumas páginas vêm com o eixo y de cima para baixo: o cabeçalho (CPF, período) mostra o sentido. */
function isTopDown(page: Page): boolean | null {
  const head = page.items.find((i) => /cpf\/cnpj|per[ií]odo|solicitado em/i.test(i.str))
  const foot = page.items.find((i) => /fale com a gente|ouvidoria|\bsac\b/i.test(i.str))
  if (head && foot) return head.y < foot.y
  if (head) return head.y < page.height / 2
  return null
}

function pageLines(page: Page, topDown: boolean): string[] {
  const rows: { y: number; items: Page['items'] }[] = []
  for (const it of page.items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5)
    if (row) row.items.push(it)
    else rows.push({ y: it.y, items: [it] })
  }
  return rows
    .sort((a, b) => (topDown ? a.y - b.y : b.y - a.y))
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
}

const MONEY = /-?\s?R\$\s?-?\d{1,3}(?:\.\d{3})*,\d{2}/g
const moneyCents = (s: string) => {
  const neg = /-/.test(s)
  const c = parseMoneyToCents(s.replace(/[-\s]|R\$/g, ''))
  return c == null ? null : neg ? -c : c
}

export function parseInterPdfLayout(pages: Page[]): ParseResult & { holderName?: string | null } {
  let orientation = false
  const lines = pages.flatMap((p) => {
    const td = isTopDown(p)
    if (td !== null) orientation = td
    return pageLines(p, orientation)
  })
  const warnings: string[] = []
  const rows: Row[] = []
  let current: string | null = null
  let holderName: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!holderName && /^cpf\/cnpj:/i.test(lines[i + 1] ?? '') && /^[A-Za-zÀ-ÿ ]{5,}$/.test(line)) holderName = line.trim()
    // "18 de Outubro de 2026 Saldo do dia: R$ 0,00 ..."
    const dh = line.match(/^(\d{1,2}) de ([A-Za-zçÇ]+) de (\d{4})\b/)
    if (dh) {
      const m = MONTHS[dh[2]!.toLowerCase()]
      current = m ? parseBrazilianDate(`${dh[1]}/${m}/${dh[3]}`) : null
      continue
    }
    if (!current) continue
    if (/^saldo\b|fale com a gente|^sac\b|ouvidoria|^valor\b/i.test(line)) continue
    const moneys = [...line.matchAll(MONEY)]
    if (moneys.length === 0) continue
    const desc = line
      .slice(0, moneys[0]!.index)
      .trim()
      .replace(/"/g, '')
      .replace(/\s+/g, ' ')
    const cents = moneyCents(moneys[0]![0])
    if (!desc || cents == null || cents === 0) continue
    rows.push({ date: current, desc, cents, saldo: moneys[1] ? moneyCents(moneys[1][0]) : null })
  }
  const check = checkRunningBalance(rows)
  if (check) warnings.push(check)
  if (rows.length === 0) warnings.push('Não encontrei lançamentos no extrato do Inter (data por extenso · descrição · valor).')
  return { drafts: toDrafts(rows, 'interpdf'), warnings, holderName }
}
