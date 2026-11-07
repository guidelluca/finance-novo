import { parseNubankDayDate } from '@/lib/currency'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

const AMOUNT_RE = /([+-]?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/

function isNoiseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/•••/.test(t)) return true
  if (/^Extrato gerado/i.test(t)) return true
  if (/^-- \d+ of \d+ --$/.test(t)) return true
  if (/^Tem alguma dúvida/i.test(t)) return true
  if (/^CPF Agência Conta$/i.test(t)) return true
  if (/^\d{5,}-\d$/.test(t)) return true
  if (/DE JANEIRO DE \d{4}/i.test(t)) return true
  if (/^\d{2}\s+[A-Z]{3}\s+\d{4}\s+Total de (entradas|saídas)/i.test(t)) return true
  if (/^Saldo\b/i.test(t)) return true
  if (/^Rendimento/i.test(t)) return true
  if (/^VALORES EM R\$/i.test(t)) return true
  if (/^Movimentações$/i.test(t)) return true
  if (/^Total de (entradas|saídas)\b/i.test(t)) return true
  if (/^R\$\s*[+-]?\d/.test(t) && !AMOUNT_RE.test(t)) return true
  return false
}

function inferKind(desc: string): 'debit' | 'credit' {
  const d = desc.toLowerCase()
  if (d.includes('estorno')) return 'credit'
  if (d.includes('resgate')) return 'credit'
  if (d.includes('pix recebido') || d.includes('transferência recebida')) return 'credit'
  if (d.includes('depósito')) return 'credit'
  return 'debit'
}

function extractSourceIdFromDescription(desc: string): { cleanDesc: string; sourceId: string | null } {
  const m = desc.match(/\b(?:id|identificador)\s*[:#-]?\s*(\d{8,20})\b/i)
  if (m?.[1]) {
    const clean = desc.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
    return { cleanDesc: clean || desc, sourceId: m[1] }
  }
  const tail = desc.match(/\s(\d{9,20})$/)
  if (tail?.[1]) {
    const clean = desc.slice(0, tail.index).replace(/\s+/g, ' ').trim()
    if (clean.length >= 2) return { cleanDesc: clean, sourceId: tail[1] }
  }
  return { cleanDesc: desc, sourceId: null }
}

function parseAmountToPositiveCents(amountStr: string): number {
  const normalized = amountStr.replace(/^[+-]/, '')
  const [intPartRaw, fracRaw = '00'] = normalized.split(',')
  const intPart = intPartRaw.replace(/\./g, '')
  const frac = fracRaw.padEnd(2, '0').slice(0, 2)
  return Math.abs(parseInt(intPart, 10) * 100 + parseInt(frac, 10))
}

let idSeq = 0
function nextId() {
  idSeq += 1
  return `nb-${idSeq}`
}

export function parseNubankExtrato(text: string): ParseResult {
  idSeq = 0
  const warnings: string[] = []
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trim())

  let currentDate: string | null = null
  const drafts: TransactionDraft[] = []
  const pending: string[] = []

  for (const line of lines) {
    if (isNoiseLine(line)) continue

    const headerDate = parseNubankDayDate(line)
    if (headerDate) {
      currentDate = headerDate
      if (/Total de (entradas|saídas)/i.test(line)) {
        pending.length = 0
        continue
      }
      pending.length = 0
      continue
    }

    if (!currentDate) continue

    const m = line.match(AMOUNT_RE)
    if (m) {
      const textBefore = line.slice(0, m.index).trim()
      const chunks = [...pending]
      if (textBefore) chunks.push(textBefore)
      const descRaw = chunks.join(' ').replace(/\s+/g, ' ').trim()
      pending.length = 0
      if (descRaw.length < 2) continue
      const { cleanDesc, sourceId } = extractSourceIdFromDescription(descRaw)

      const cents = parseAmountToPositiveCents(m[1])
      const kind = inferKind(cleanDesc)

      drafts.push({
        tempId: nextId(),
        date: currentDate,
        amountCents: cents,
        kind,
        descriptionRaw: cleanDesc,
        sourceId,
      })
      continue
    }

    pending.push(line)
  }

  if (!text.includes('Movimentações') && !text.includes('Compra no débito')) {
    warnings.push('Texto pode não ser um extrato Nubank; confira o arquivo.')
  }

  return { drafts, warnings }
}
