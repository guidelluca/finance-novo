/**
 * Converte linhas de OCR (com posição) de prints bancários em transações.
 * Sem dependências: testável isoladamente. Pensado para listas de apps (Nubank, Itaú, Inter, C6, MP, PicPay…)
 * e faturas de cartão: cabeçalho de data → linhas com descrição e valor.
 */
import type { AiScreenshotRow } from './screenshotNormalize'

export type OcrLine = {
  text: string
  x0: number
  y0: number
  y1: number
  /** 0–100 */
  confidence: number
  /** cor do valor no print, quando detetada */
  amountColor?: 'green' | 'red' | null
}

export type OcrPage = { lines: OcrLine[]; height: number }

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
}

/** Valor BR. Sinal pode vir antes do R$ ou do número; OCR às vezes troca − por "—", "–" ou "~". */
const AMOUNT_RE = /([+\-−–—~]\s*)?(R\s?\$\s*)?([+\-−–—]\s*)?(\d{1,3}(?:[.\s]\d{3})*,\d{2})(?!\d)/g

const TIME_RE = /\b\d{1,2}[:h]\d{2}\b/g

const NON_TX_WITH_AMOUNT =
  /\b(saldo|limite|total|dispon[ií]vel|fatura (atual|fechada|aberta|anterior)|valor da fatura|pagamento m[ií]nimo|rendimento (do|no) m[eê]s|rendeu|cdi)\b/i

const NOISE_ROW =
  /^(hist[oó]rico|movimenta[cç][oõ]es|extrato|lan[cç]amentos|transa[cç][oõ]es|[uú]ltimos lan[cç]amentos|ver (tudo|mais)|filtr(ar|os)|buscar|pesquisar|entradas|sa[ií]das|todas|futuros|minha conta|conta|cart[aã]o|cart[oõ]es|in[ií]cio|pix|pagar|transferir|investir|mais|menu|ajuda|compartilhar|baixar|exportar|voltar)$/i

const NAV_WORDS = new Set([
  'início', 'inicio', 'pix', 'pagar', 'transferir', 'cartões', 'cartoes', 'cartão', 'cartao', 'extrato',
  'mais', 'investir', 'investimentos', 'menu', 'conta', 'shopping', 'loja', 'ajuda', 'perfil', 'buscar', 'home',
])

const IN_HINT = /recebid|estorno|reembolso|sal[aá]rio|dep[oó]sito|resgate|cashback|devolu[cç]|rendimento|cr[eé]dito em conta|ted recebida/i
const OUT_HINT = /enviad|compra|pagamento (de|efetuado|realizado)|\bpago\b|d[eé]bito|tarifa|saque|boleto|aplica[cç][aã]o|pix (para|transf)|transfer[eê]ncia (para|enviada)|assinatura/i

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function buildDate(y: number, m: number, d: number, today: string, yearGiven: boolean): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  let iso = `${y}-${pad(m)}-${pad(d)}`
  const test = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(test.getTime()) || test.toISOString().slice(0, 10) !== iso) return null
  if (!yearGiven && iso > isoAddDays(today, 1)) iso = `${y - 1}-${pad(m)}-${pad(d)}`
  return iso
}

/** Data em qualquer formato comum de app BR. */
export function parseDateText(text: string, today: string): string | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (/^\s*hoje\b/.test(t)) return today
  if (/^\s*ontem\b/.test(t)) return isoAddDays(today, -1)
  const ty = Number(today.slice(0, 4))

  // 3 de novembro de 2026 · 03 NOV 2026 · seg, 3 nov · 03 nov.
  const m1 = t.match(/\b(\d{1,2})\s*(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?(?:\s*(?:de\s+)?(\d{4}))?/)
  if (m1) {
    const y = m1[3] ? Number(m1[3]) : ty
    return buildDate(y, MONTHS[m1[2]!]!, Number(m1[1]), today, Boolean(m1[3]))
  }
  // 03/11/2026 · 03/11/26 · 03/11
  const m2 = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (m2) {
    let y = ty
    if (m2[3]) y = m2[3].length === 2 ? 2000 + Number(m2[3]) : Number(m2[3])
    return buildDate(y, Number(m2[2]), Number(m2[1]), today, Boolean(m2[3]))
  }
  return null
}

function stripDateText(s: string): string {
  return s
    .replace(/\b(hoje|ontem)\b/gi, '')
    .replace(/\b(seg|ter|qua|qui|sex|s[aá]b|dom)[a-zç-]*,?\s*/gi, '')
    .replace(/\b\d{1,2}\s*(de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\.?(\s*(de\s+)?\d{4})?/gi, '')
    .replace(/^\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, '') // só a data no início da linha (ex.: Itaú)
}

function cleanDescription(s: string): string {
  return s
    .replace(TIME_RE, '')
    .replace(/R\s?\$/g, '')
    .replace(/[|•·]+/g, ' ')
    .replace(/^[^\p{L}\p{N}*]+/u, '') // ícones lidos como "©", "@", "»"…
    .replace(/[^\p{L}\p{N})*.]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

type Row = { text: string; y0: number; y1: number; confidence: number; amountColor: 'green' | 'red' | null }

/** Junta caixas na mesma altura (descrição à esquerda + valor à direita) numa linha visual. */
export function groupIntoRows(lines: OcrLine[]): Row[] {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const groups: OcrLine[][] = []
  for (const l of sorted) {
    const mid = (l.y0 + l.y1) / 2
    const g = groups.find((gr) => {
      const top = Math.min(...gr.map((x) => x.y0))
      const bot = Math.max(...gr.map((x) => x.y1))
      return mid >= top && mid <= bot
    })
    if (g) g.push(l)
    else groups.push([l])
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x0 - b.x0)
    return {
      text: g.map((x) => x.text).join('  '),
      y0: Math.min(...g.map((x) => x.y0)),
      y1: Math.max(...g.map((x) => x.y1)),
      confidence: g.reduce((s, x) => s + x.confidence, 0) / g.length,
      amountColor: g.find((x) => x.amountColor)?.amountColor ?? null,
    }
  })
}

function isNavRow(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.filter((w) => NAV_WORDS.has(w)).length >= Math.ceil(words.length * 0.6)
}

function isStatusBar(row: Row, pageHeight: number, text: string): boolean {
  if (row.y1 > pageHeight * 0.07) return false
  return /^\s*\d{1,2}:\d{2}\b/.test(text) || /\d{1,3}\s?%/.test(text) || /\b(4g|5g|lte|wi-?fi)\b/i.test(text)
}

export type OcrParseOutput = { rows: AiScreenshotRow[]; lastDate: string | null }

export function parseOcrPages(pages: OcrPage[], today: string, startDate: string | null = null): OcrParseOutput {
  const out: AiScreenshotRow[] = []
  let currentDate: string | null = startDate
  let dateFromThisPrint = false

  pages.forEach((page, pageIdx) => {
    const printNo = pageIdx + 1
    dateFromThisPrint = false
    let pending: string[] = []

    for (const row of groupIntoRows(page.lines)) {
      const text = row.text.trim()
      if (!text) continue
      if (isStatusBar(row, page.height, text)) continue
      if (isNavRow(text) || NOISE_ROW.test(cleanDescription(text))) {
        continue
      }

      const amounts = [...text.matchAll(AMOUNT_RE)]
      if (amounts.length === 0) {
        const d = parseDateText(text, today)
        const rest = cleanDescription(stripDateText(text))
        if (d && rest.length <= 6) {
          // cabeçalho de data ("Hoje", "Seg, 3 nov", "03/11/2026")
          currentDate = d
          dateFromThisPrint = true
          pending = []
          continue
        }
        if (/^\s*\d{1,2}[:h]\d{2}\s*$/.test(text)) continue
        const desc = cleanDescription(text)
        if (desc.length >= 2) pending = [...pending, desc].slice(-3)
        continue
      }

      if (NON_TX_WITH_AMOUNT.test(text)) {
        pending = []
        continue
      }

      // Valor: o primeiro com sinal explícito; senão o último (mais à direita)
      const signed = amounts.find((m) => m[1] || m[3])
      const chosen = signed ?? amounts[amounts.length - 1]!
      const sign = (chosen[1] ?? chosen[3] ?? '').trim()
      const amount = chosen[4]!.replace(/\s/g, '.')

      const inlineDate = parseDateText(text.slice(0, chosen.index), today)
      if (inlineDate) {
        currentDate = inlineDate
        dateFromThisPrint = true
      }

      const before = text.slice(0, chosen.index) + ' ' + text.slice(chosen.index! + chosen[0].length)
      const rowDesc = cleanDescription(stripDateText(before.replace(AMOUNT_RE, ' ')))
      const parts = [...pending, rowDesc].filter((p) => p && p.length >= 2)
      const description = parts.join(' · ')
      pending = []

      let direction: 'in' | 'out' | null = null
      if (sign === '+') direction = 'in'
      else if (sign) direction = 'out'
      else if (IN_HINT.test(description)) direction = 'in'
      else if (row.amountColor === 'green') direction = 'in'
      else if (row.amountColor === 'red') direction = 'out'
      else if (OUT_HINT.test(description)) direction = 'out'

      const inst = description.match(/parc(?:ela)?\.?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})/i)
      const installment = inst ? `${inst[1]}/${inst[2]}` : null
      const confidence0 = Math.max(0, Math.min(1, row.confidence / 100))
      const confidence = description ? confidence0 : Math.min(confidence0, 0.5)

      out.push({
        print: printNo,
        date: currentDate,
        date_inferred: Boolean(currentDate) && !dateFromThisPrint,
        description: description || 'Transação (sem descrição no print)',
        amount,
        direction,
        status: /\b(agendad|pendente|processando|pr[eé]-autoriza)/i.test(text + ' ' + description) ? 'pending' : 'posted',
        installment,
        confidence,
      })
    }
  })

  return { rows: out, lastDate: currentDate }
}
