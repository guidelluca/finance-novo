import { parseBrazilianDate, parseBrazilianMoneyToCents } from '@/lib/currency'
import type { ParseResult } from '@/parsers/types'

let idSeq = 0
function nextId() {
  idSeq += 1
  return `mp-${idSeq}`
}

/** Normaliza texto: NBSP, menos unicode, espaços. */
function normalizeSpaces(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/\u2212/g, '-')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDateAtStart(chunk: string): { iso: string; rest: string } | null {
  const s = chunk.trim()
  const dash = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(.*))?$/s)
  if (dash) {
    const iso = `${dash[3]}-${dash[2]}-${dash[1]}`
    return { iso, rest: (dash[4] ?? '').trim() }
  }
  const slash = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(.*))?$/s)
  if (slash) {
    const iso = parseBrazilianDate(`${slash[1]}/${slash[2]}/${slash[3]}`)
    if (!iso) return null
    return { iso, rest: (slash[4] ?? '').trim() }
  }
  return null
}

function isNoiseLine(line: string): boolean {
  const t = normalizeSpaces(line)
  if (!t) return true
  if (/^EXTRATO DE CONTA$/i.test(t)) return true
  if (/^DETALHE DOS MOVIMENTOS$/i.test(t)) return true
  if (/^Data Descri[çc][aã]o ID da opera[çc][aã]/i.test(t)) return true
  if (/^Data Descri[çc][aã]o/i.test(t) && /ID da opera/i.test(t)) return true
  if (/^\d+\/\d+$/.test(t)) return true
  if (/^-- \d+ of \d+ --$/i.test(t)) return true
  if (/^Saldo inicial:/i.test(t)) return true
  if (/^Saldo final:/i.test(t)) return true
  if (/^Data de gera[çc][aã]o:/i.test(t)) return true
  if (/^Voc[eê] tem alguma d[uú]vida\?/i.test(t)) return true
  if (/^Mercado Pago Institui[çc][aã]o de Pagamento/i.test(t)) return true
  if (/^CPF\/CNPJ:/i.test(t)) return true
  if (/^De \d{2}[-/]\d{2}[-/]\d{4}\b/i.test(t)) return true
  if (/Periodo:/i.test(t) && /^De /i.test(t)) return true
  if (/^Entradas:|^Saidas:|^Sa[ií]das:/i.test(t)) return true
  return false
}

const BRL_TAIL =
  /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:R\$\s*-?\d{1,3}(?:\.\d{3})*,\d{2})?\s*$/i

/** Números de operação no extrato: 9–13 dígitos comuns; rendimentos podem ter mais. */
const OP_ID = /(\d{7,22})/

/**
 * Do final: valor (e opcional saldo), depois ID, resto = descrição.
 * Aceita R$ opcional e variações de espaço do pdf.js.
 */
function tryParseMovement(dateIso: string, mergedRaw: string) {
  const merged = normalizeSpaces(mergedRaw)
  if (merged.length < 8) return null

  const mTail = merged.match(BRL_TAIL)
  if (!mTail || mTail.index === undefined) return null
  const beforeAmount = merged.slice(0, mTail.index).trim()
  const amountCents = parseBrazilianMoneyToCents(mTail[1])
  if (amountCents == null || amountCents === 0) return null

  const idMatch = [...beforeAmount.matchAll(new RegExp(OP_ID.source, 'g'))]
  if (idMatch.length === 0) return null
  const lastId = idMatch[idMatch.length - 1]!
  const idStart = lastId.index ?? 0
  const opId = lastId[1]
  const descriptionRaw = beforeAmount.slice(0, idStart).replace(/\s+/g, ' ').trim().slice(0, 500)
  if (descriptionRaw.length < 1) return null

  return {
    date: dateIso,
    amountCents: Math.abs(amountCents),
    kind: amountCents < 0 ? ('debit' as const) : ('credit' as const),
    descriptionRaw,
    sourceId: opId.slice(0, 256),
  }
}

export function parseMercadoPagoExtrato(text: string): ParseResult {
  idSeq = 0
  const warnings: string[] = []
  const drafts: ParseResult['drafts'] = []

  const rawLines = text.split(/\n/)
  let currentDate: string | null = null
  const pendingParts: string[] = []

  const flush = () => {
    if (!currentDate || pendingParts.length === 0) return
    const parsed = tryParseMovement(currentDate, pendingParts.join(' '))
    if (parsed) drafts.push({ tempId: nextId(), ...parsed })
    pendingParts.length = 0
  }

  for (const raw of rawLines) {
    const line = normalizeSpaces(raw)
    if (isNoiseLine(line)) continue

    const onlyDate = parseDateAtStart(line)
    if (onlyDate && onlyDate.rest === '') {
      flush()
      currentDate = onlyDate.iso
      continue
    }

    const embedded = line.match(/(\d{2}-\d{2}-\d{4}|\d{2}\/\d{2}\/\d{4})\s+(.+)/)
    if (embedded) {
      flush()
      const chunk = embedded[1] + (embedded[2] ? ` ${embedded[2]}` : '')
      const parsedStart = parseDateAtStart(chunk)
      if (parsedStart) {
        currentDate = parsedStart.iso
        if (parsedStart.rest) pendingParts.push(parsedStart.rest)
      }
      continue
    }

    if (!currentDate) continue
    pendingParts.push(line)
  }

  flush()

  if (drafts.length === 0) {
    warnings.push(
      'Nenhum lançamento do extrato Mercado Pago foi reconhecido. ' +
        'Use o PDF “Extrato de conta” (texto selecionável). Se for outro tipo de extrato ou PDF só imagem, exporte em CSV ou envie um exemplo para ajustar o parser.',
    )
  }

  return { drafts, warnings }
}
