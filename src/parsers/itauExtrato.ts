import { parseBrazilianDate, parseBrazilianMoneyToCents } from '@/lib/currency'
import type { ParseResult } from '@/parsers/types'

let idSeq = 0
function nextId() {
  idSeq += 1
  return `it-${idSeq}`
}

/** Datas como o PDF costuma extrair: com ou sem espaços em torno das barras */
const DATE_TOKEN =
  /(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{4})/g

/** Valores estilo BR: 1.234,56 ou 12,34; opcional R$; menos no início ou fim */
const BRL_VALUE = /(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?/gi

function collectMoneyTokens(segment: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(BRL_VALUE.source, BRL_VALUE.flags)
  while ((m = re.exec(segment)) !== null) {
    out.push(m[0])
  }
  return out
}

/**
 * Heurística para extratos Itaú com texto selecionável. O pdfText junta itens da
 * página num fluxo contínuo; por isso cortamos o texto em segmentos por cada
 * data DD/MM/AAAA e lemos o 1.º valor monetário não-zero de cada segmento.
 */
export function parseItauExtrato(text: string): ParseResult {
  idSeq = 0
  const warnings: string[] = []
  const drafts: ParseResult['drafts'] = []
  if (text.trim().length < 50) {
    warnings.push(
      'Pouco texto extraído do PDF. Se o Itaú gerou PDF sem camada de texto, use exportação CSV ou OCR.',
    )
    return { drafts, warnings }
  }

  const rawMatches = [...text.matchAll(DATE_TOKEN)]
  const dated: { start: number; end: number; iso: string }[] = []
  for (const m of rawMatches) {
    if (m.index === undefined || !m[1] || !m[2] || !m[3]) continue
    const iso = parseBrazilianDate(`${m[1]}/${m[2]}/${m[3]}`)
    if (!iso) continue
    dated.push({ start: m.index, end: m.index + m[0].length, iso })
  }

  if (dated.length === 0) {
    warnings.push(
      'Nenhuma data DD/MM/AAAA encontrada no texto do PDF. Se o extrato for só imagem (scan), exporte em CSV no Itaú ou use um PDF com texto selecionável.',
    )
    return { drafts, warnings }
  }

  for (let i = 0; i < dated.length; i++) {
    const { end, iso } = dated[i]!
    const segEnd = i + 1 < dated.length ? dated[i + 1]!.start : text.length
    const segment = text.slice(end, segEnd).trim()
    if (!segment) continue

    const tokens = collectMoneyTokens(segment)
    let cents: number | null = null
    let usedToken: string | null = null
    for (const tok of tokens) {
      const c = parseBrazilianMoneyToCents(tok)
      if (c != null && c !== 0) {
        cents = c
        usedToken = tok
        break
      }
    }
    if (cents == null || usedToken == null) continue

    let desc = segment
      .replace(usedToken, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[\s|-]+$/g, '')
      .replace(/^[\s|-]+/g, '')
      .trim()

    if (desc.length < 2) desc = 'Lançamento Itaú'

    const lower = desc.toLowerCase()
    const lineForKind = `${segment} ${desc}`
    const kind: 'debit' | 'credit' =
      /\b(créd|credito|deposito|pix recebido|salario|ted enviada para você)\b/i.test(lower) ||
      /\b(créd\.|c r e d)\b/i.test(lineForKind)
        ? 'credit'
        : 'debit'

    drafts.push({
      tempId: nextId(),
      date: iso,
      amountCents: Math.abs(cents),
      kind,
      descriptionRaw: desc.slice(0, 500),
    })
  }

  if (drafts.length === 0) {
    warnings.push(
      'Foram encontradas datas, mas nenhum valor no formato brasileiro (ex.: 10,50 ou 1.234,56) a seguir. Tente o CSV do Itaú ou confira se o PDF permite selecionar/copiar o texto.',
    )
  }

  return { drafts, warnings }
}
