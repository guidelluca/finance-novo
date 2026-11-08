import { parseBrazilianDate, parseBrazilianMoneyToCents } from '@/lib/currency'
import type { ParseResult } from '@/parsers/types'

type Page = { width: number; height: number; items: { x: number; y: number; w: number; str: string }[] }

const MONEY = /-?\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])/g
const BALANCE_LINE = /^saldo\b|saldo do dia|saldo anterior|saldo total|saldo final|saldo em conta/i

/** Junta os itens da página em linhas (mesma altura), da esquerda para a direita. */
function pageLines(page: Page): string[] {
  const rows: { y: number; items: Page['items'] }[] = []
  for (const it of [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5)
    if (row) row.items.push(it)
    else rows.push({ y: it.y, items: [it] })
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Data real da operação quando o Itaú cola "dd/mm" no fim da descrição
 * ("PIX QRS MERCADO PAG08/11" lançado em 09/11): usa se estiver até 10 dias antes.
 */
function innerDate(posted: string, dd: string, mm: string): string | null {
  const y = Number(posted.slice(0, 4))
  for (const year of [y, y - 1]) {
    const iso = parseBrazilianDate(`${dd}/${mm}/${year}`)
    if (iso && iso <= posted && iso >= isoAddDays(posted, -10)) return iso
  }
  return null
}

/**
 * Extrato de conta Itaú (PDF "extrato conta / lançamentos"), lido linha a linha pela posição:
 * data · lançamento · valor (R$) · saldo (R$). Linhas "SALDO DO DIA" são saldo, não transação;
 * o sinal do valor decide entrada/saída. Confere a soma de cada dia contra a variação do saldo.
 */
export function parseItauExtratoLayout(pages: Page[]): ParseResult & { balanceChecked?: number; balanceMismatches?: number } {
  const warnings: string[] = []
  const drafts: ParseResult['drafts'] = []
  let periodEnd: string | null = null
  let holderFirst: string | null = null
  const saldoByDate = new Map<string, number>()
  const valuesByDate = new Map<string, number>()
  let seq = 0

  const allLines = pages.flatMap((page) => pageLines(page))
  // 1.º passo: titular e período (o cabeçalho nem sempre vem antes das linhas no PDF)
  for (const line of allLines) {
    const period = line.match(/per[ií]odo de visualiza[cç][aã]o:?\s*\d{2}\/\d{2}\/\d{4}\s*at[eé]\s*(\d{2}\/\d{2}\/\d{4})/i)
    if (period && !periodEnd) periodEnd = parseBrazilianDate(period[1]!)
    // "Guilherme de Luca Santos 000.000.000-00 agência: 0000 conta: 00000-0"
    const holder = !holderFirst && line.match(/^([A-Za-zÀ-ÿ]{3,})(?:\s+[A-Za-zÀ-ÿ]+)*\s+[\d.*]{3,}[\d.*-]*\s+ag[eê]ncia/i)
    if (holder) holderFirst = holder[1]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  }

  {
    for (const line of allLines) {
      const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+)$/)
      if (!m) continue
      const posted = parseBrazilianDate(m[1]!)
      if (!posted) continue
      const rest = m[2]!
      const moneys = [...rest.matchAll(MONEY)]
      if (moneys.length === 0) continue
      const first = moneys[0]!
      const desc0 = rest.slice(0, first.index).trim()
      if (BALANCE_LINE.test(desc0)) {
        const c = parseBrazilianMoneyToCents(moneys[moneys.length - 1]![0])
        if (c != null) saldoByDate.set(posted, c)
        continue
      }
      const cents = parseBrazilianMoneyToCents(first[0])
      if (cents == null || cents === 0) continue
      // quando a linha também traz o saldo (2.º valor), guarda para conferência
      if (moneys.length > 1) {
        const s = parseBrazilianMoneyToCents(moneys[moneys.length - 1]![0])
        if (s != null) saldoByDate.set(posted, s)
      }
      valuesByDate.set(posted, (valuesByDate.get(posted) ?? 0) + cents)

      let date = posted
      let desc = desc0
      const glued = desc.match(/^(.*?)\s?(\d{2})\/(\d{2})$/)
      if (glued && glued[1]!.trim().length >= 2) {
        const inner = innerDate(posted, glued[2]!, glued[3]!)
        if (inner) {
          date = inner
          desc = glued[1]!.trim()
        }
      }
      // Pix/TED para o próprio titular (outra conta sua): o Itaú corta o nome em 7 letras ("PIX TRANSF Guilher")
      const to = desc.match(/^(?:PIX (?:TRANSF|CARTAO|CARTÃO)|TED|TEF|DOC)\s+([A-Za-zÀ-ÿ]{4,})\b/i)
      if (holderFirst && to) {
        const who = to[1]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
        if (holderFirst.startsWith(who)) desc = `${desc} · conta própria`
      }
      seq += 1
      drafts.push({
        tempId: `itl-${seq}`,
        date,
        amountCents: Math.abs(cents),
        kind: cents < 0 ? 'debit' : 'credit',
        descriptionRaw: desc.slice(0, 500) || 'Lançamento Itaú',
      })
    }
  }

  // conferência: saldo(dia) − saldo(dia anterior com saldo) = soma dos lançamentos entre eles
  const saldoDates = [...saldoByDate.keys()].filter((d) => !periodEnd || d <= periodEnd).sort()
  let checked = 0
  let mismatches = 0
  const mismatchRanges: string[] = []
  const fmt = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  for (let i = 1; i < saldoDates.length; i++) {
    const a = saldoDates[i - 1]!
    const b = saldoDates[i]!
    const last = i === saldoDates.length - 1
    let sum = 0
    // o último saldo já inclui lançamentos com data futura (ex.: Pix do fim de semana lançado na segunda)
    for (const [d, v] of valuesByDate) if (d > a && (d <= b || last)) sum += v
    checked += 1
    if (saldoByDate.get(b)! - saldoByDate.get(a)! !== sum) {
      mismatches += 1
      mismatchRanges.push(`${fmt(a)}–${fmt(b)}`)
    }
  }

  if (drafts.length === 0) {
    warnings.push('Não encontrei lançamentos no formato do extrato Itaú (data · lançamento · valor).')
  } else if (checked > 0 && mismatches === 0) {
    warnings.push(`Conferido: os ${drafts.length} lançamentos batem com o saldo de todos os ${checked} dias do extrato.`)
  } else if (mismatches > 0) {
    warnings.push(
      `Conferi com o saldo: ${checked - mismatches} de ${checked} períodos batem. Não batem (pode ser lançamento estornado pelo banco): ${mismatchRanges.slice(0, 5).join(', ')}.`,
    )
  }
  return { drafts, warnings, balanceChecked: checked, balanceMismatches: mismatches }
}
