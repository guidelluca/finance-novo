import type { ParseResult, TransactionDraft } from '@/parsers/types'

/** Converte parte "1.234,56" ou "40,89" em centavos (sem símbolo). */
function brPartToCents(part: string): number {
  const t = part.replace(/\./g, '').replace(',', '.').trim()
  const n = Number(t)
  if (Number.isNaN(n) || n < 0) return 0
  return Math.round(n * 100)
}

function dmyToIso(dmy: string): string | null {
  const m = dmy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

function extractHintCategory(beforeAmount: string): string | null {
  const tail = beforeAmount.slice(-220)
  const catM = tail.match(/(?:^|\s)([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{0,36}?)\s+Débito\s*$/iu)
  if (!catM) return null
  const h = catM[1]!.trim()
  if (/^(Saída|Entrada|Pix|Débito|Mercado)$/i.test(h)) return null
  return h
}

function findIsoDateNear(text: string, amountIdx: number): string | null {
  const back = text.slice(Math.max(0, amountIdx - 1800), amountIdx)
  const backDates = [...back.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)]
  if (backDates.length) {
    const dmy = backDates[backDates.length - 1]![1]!
    return dmyToIso(dmy)
  }
  const fwd = text.slice(amountIdx, Math.min(text.length, amountIdx + 500))
  const fwdM = fwd.match(/(\d{2}\/\d{2}\/\d{4})/)
  return fwdM ? dmyToIso(fwdM[1]!) : null
}

function descriptionFromWindow(beforeForDesc: string): string {
  const dates = [...beforeForDesc.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)]
  let start = 0
  let lastDmy = ''
  if (dates.length) {
    const last = dates[dates.length - 1]!
    lastDmy = last[1]!
    start = (last.index ?? 0) + last[0].length
  }
  let slice = beforeForDesc.slice(start).replace(/\s+/g, ' ').trim()
  const cutNextMoney = slice.search(/\s-R\$\s*[\d.]+,\d{2}/)
  if (cutNextMoney >= 0) slice = slice.slice(0, cutNextMoney).trim()
  const cutEntrada = slice.search(/\bEntrada\s+R\$\s*[\d.]+,\d{2}/)
  if (cutEntrada >= 0) slice = slice.slice(0, cutEntrada).trim()
  if (slice.length > 0) return slice.slice(0, 300)
  return lastDmy ? `Movimento ${lastDmy}` : ''
}

/** Texto após “-R$ X” quando a data completa vem a seguir (layout PDF controle de gastos). */
function descriptionAfterDebitAmount(text: string, amountEndIdx: number): string {
  const after = text.slice(amountEndIdx, Math.min(text.length, amountEndIdx + 720))
  let s = after.replace(/^\s*(?:\d{2}\/\d{4}\s+\d{4}\s*)+/, '').trim()
  const m = s.match(/^(\d{2}\/\d{2}\/\d{4})\s+/)
  if (!m) return ''
  s = s.slice(m[0].length).replace(/\s+/g, ' ').trim()
  const cutMoney = s.search(/\s-R\$\s*[\d.]+,\d{2}/)
  if (cutMoney >= 0) s = s.slice(0, cutMoney).trim()
  const cutSaída = s.search(
    /\sSaída\s+(?:Mercado|Débito|Pix|Entrada|Transferência|Alimentação|Financeiro|Contas|Débito\s)/,
  )
  if (cutSaída >= 0) s = s.slice(0, cutSaída).trim()
  for (let len = Math.floor(s.length / 2); len >= 15; len--) {
    const a = s.slice(0, len).trimEnd()
    if (s.slice(len).trimStart().startsWith(a)) {
      s = a
      break
    }
  }
  return s.slice(0, 300)
}

/**
 * PDF “Controle de Gastos” / extrato exportado (texto misto colunas Nubank-like).
 * Extrai -R$… (débitos) e Entrada R$… (créditos). Usa a última data DD/MM/YYYY antes do valor.
 */
export function parseControleGastosExtrato(text: string): ParseResult {
  const drafts: TransactionDraft[] = []
  const warnings: string[] = []
  let seq = 0

  const push = (d: Omit<TransactionDraft, 'tempId'>) => {
    drafts.push({ ...d, tempId: `cg-${seq++}` })
  }

  for (const m of text.matchAll(/-R\$\s*([\d.]+,\d{2})/g)) {
    const idx = m.index ?? 0
    const cents = brPartToCents(m[1]!)
    if (cents <= 0) continue
    const before = text.slice(Math.max(0, idx - 1800), idx)
    const iso = findIsoDateNear(text, idx)
    if (!iso) {
      warnings.push(`Débito R$ ${m[1]} sem data — ignorado.`)
      continue
    }
    const amountEnd = idx + m[0].length
    const fromAfter = descriptionAfterDebitAmount(text, amountEnd)
    const fromBefore = descriptionFromWindow(before)
    let desc = fromAfter || fromBefore
    if (/Descrição Histórico|Forma de\s+Data/i.test(desc)) {
      desc = fromAfter || `Débito ${m[1]} (${iso})`
    }
    const categoryHint = extractHintCategory(before)
    push({
      date: iso,
      amountCents: cents,
      kind: 'debit',
      descriptionRaw: desc || `Débito ${m[1]} (${iso})`,
      categoryHint,
    })
  }

  for (const m of text.matchAll(/\bEntrada\s+R\$\s*([\d.]+,\d{2})/g)) {
    const idx = m.index ?? 0
    const cents = brPartToCents(m[1]!)
    if (cents <= 0) continue
    const before = text.slice(Math.max(0, idx - 1800), idx)
    const iso = findIsoDateNear(text, idx)
    if (!iso) {
      warnings.push(`Crédito R$ ${m[1]} (Entrada) sem data — ignorado.`)
      continue
    }
    const desc = descriptionFromWindow(before)
    push({
      date: iso,
      amountCents: cents,
      kind: 'credit',
      descriptionRaw: desc || `Entrada ${m[1]} (${iso})`,
    })
  }

  return { drafts, warnings }
}
