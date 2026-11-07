/**
 * Faturas de cartão de crédito em PDF (PicPay, Itaú/Itaucard e layouts parecidos).
 *
 * Por que precisa de posição (x/y): essas faturas têm 2 colunas de lançamentos lado a lado.
 * Lendo só o texto, as colunas se misturam. Aqui as colunas são separadas pela posição das datas,
 * e cada coluna é lida de cima para baixo, respeitando as seções da fatura:
 *   - "Pagamentos efetuados" / "Pagamento de fatura" → ignorados (é transferência, não gasto)
 *   - "Compras parceladas – próximas faturas" → ignorado (ainda não foi cobrado)
 *   - "Repasse de IOF" (compras internacionais) → vira lançamento
 * No fim, confere a soma com o total impresso na fatura.
 *
 * Sem dependências (testável isoladamente).
 */
import type { ParseResult, TransactionDraft } from './types'

export type PdfItem = { x: number; y: number; w: number; str: string }
/** y de cima para baixo */
export type PdfPage = { width: number; height: number; items: PdfItem[] }

export type FaturaParseResult = ParseResult & {
  bank: string | null
  closingDate: string | null
  statedTotalCents: number | null
  computedTotalCents: number
  /** finais de cartão encontrados (titular e adicionais) */
  cardLast4s: string[]
}

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
}

const AMOUNT = String.raw`(-\s?)?(?:R\$\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})`
const TX_NUMERIC = new RegExp(String.raw`^(\d{2})\/(\d{2})\s+(.+?)\s+${AMOUNT}$`)
const TX_MONTHNAME = new RegExp(
  String.raw`^(\d{2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.?\s+(.+?)\s+${AMOUNT}$`,
  'i',
)

const SECTION_SKIP =
  /^(?:[A-Z]\s)?(pagamentos efetuados|compras parceladas\s*-?\s*pr[oó]ximas faturas|lan[cç]amentos futuros|parcelas futuras|pr[oó]ximas faturas)\b/i
const SECTION_INCLUDE =
  /(lan[cç]amentos:?\s*compras|lan[cç]amentos (nacionais|internacionais|no cart[aã]o)|transa[cç][oõ]es (nacionais|internacionais)|despesas)/i
const STATED_TOTAL = new RegExp(
  String.raw`\b(?:total (?:geral )?dos lan[cç]amentos(?: atuais)?|total de despesas)\s+(?:em R\$\s+)?${AMOUNT}\s*$`,
  'i',
)
const IOF_LINE = new RegExp(String.raw`\b(repasse de iof|iof (?:sobre |de )?compras? (?:no |do )?exterior)\b.*?${AMOUNT}\s*$`, 'i')
const PAYMENT_DESC = /^(pagamento( de fatura| via conta| recebido| efetuado| obrigado)?|pgto\b|pag\s?fatura)/i

function centsOf(sign: string | undefined, num: string): number {
  const v = Math.round(Number(num.replace(/\./g, '').replace(',', '.')) * 100)
  return sign ? -v : v
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDayOfMonth(y, m)))}`
}

function addMonths(y: number, m: number, d: number, k: number): string {
  const t = m - 1 + k
  const ny = y + Math.floor(t / 12)
  const nm = (((t % 12) + 12) % 12) + 1
  return iso(ny, nm, d)
}

/** Agrupa itens na mesma altura numa linha, ordenados da esquerda para a direita. */
export function itemsToLines(items: PdfItem[]): string[] {
  const sorted = [...items].filter((i) => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: PdfItem[][] = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row[0]!.y - it.y) <= 2.5) row.push(it)
    else rows.push([it])
  }
  return rows.map((r) =>
    r
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

const DATE_TOKEN = /^\d{2}\/\d{2}(?!\/?\d)/

const AMOUNT_ONLY = /^-?\s?(?:R\$\s?)?\d{1,3}(?:\.\d{3})*,\d{2}$/

/**
 * Separa a página em colunas quando há datas de lançamento em duas faixas de x bem distantes.
 * Só conta como "data de lançamento" o dd/mm seguido de texto; dd/mm seguido de valor é parcela ("09/10 117,08").
 */
export function splitColumns(page: PdfPage): PdfItem[][] {
  const items = page.items.filter((i) => i.str.trim())
  const xs: number[] = []
  for (const it of items) {
    if (!DATE_TOKEN.test(it.str.trim())) continue
    const next = items
      .filter((o) => o !== it && Math.abs(o.y - it.y) <= 2.5 && o.x > it.x)
      .sort((a, b) => a.x - b.x)[0]
    const rest = it.str.trim().slice(5).trim()
    const following = rest || next?.str.trim() || ''
    if (!following || AMOUNT_ONLY.test(following)) continue
    xs.push(it.x)
  }
  xs.sort((a, b) => a - b)
  let bestGap = 0
  let splitAt = -1
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i]! - xs[i - 1]!
    if (gap > bestGap) {
      bestGap = gap
      splitAt = xs[i]!
    }
  }
  if (splitAt < 0 || bestGap < page.width * 0.25) return [page.items]
  const cut = splitAt - 4
  return [page.items.filter((i) => i.x < cut), page.items.filter((i) => i.x >= cut)]
}

function detectBank(text: string): string | null {
  if (/picpay/i.test(text)) return 'PicPay'
  if (/ita[uú]\s*cart[oõ]es|itaucard|ita[uú] unibanco|\bita[uú]\b/i.test(text)) return 'Itaú'
  if (/nubank|nu pagamentos/i.test(text)) return 'Nubank'
  if (/banco inter\b|\binter\b.*cart/i.test(text)) return 'Inter'
  if (/\bc6\b/i.test(text)) return 'C6 Bank'
  if (/santander/i.test(text)) return 'Santander'
  if (/bradesco/i.test(text)) return 'Bradesco'
  if (/mercado pago/i.test(text)) return 'Mercado Pago'
  if (/caixa econ/i.test(text)) return 'Caixa'
  if (/banco do brasil|ourocard/i.test(text)) return 'Banco do Brasil'
  return null
}

function findClosingDate(text: string): string | null {
  const pick = (re: RegExp) => {
    const m = text.match(re)
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null
  }
  const closing =
    pick(/(?<!pr[oó]x\.?\s{0,2}|previs[aã]o\s{0,2}|pr[oó]ximo\s{0,2})fechamento(?: da fatura)?:?\s*(\d{2})\/(\d{2})\/(\d{4})/i) ??
    pick(/emiss[aã]o:?\s*(\d{2})\/(\d{2})\/(\d{4})/i) ??
    pick(/postagem:?\s*(\d{2})\/(\d{2})\/(\d{4})/i)
  if (closing) return closing
  const due = pick(/vencimento:?\s*(\d{2})\/(\d{2})\/(\d{4})/i)
  if (!due) return null
  const d = new Date(`${due}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 7)
  return d.toISOString().slice(0, 10)
}

/** Fatura de cartão? (para a detecção automática do tipo de PDF) */
export function looksLikeCreditCardInvoice(text: string): boolean {
  const t = text.slice(0, 20000)
  return (
    /vencimento/i.test(t) &&
    /pagamento m[ií]nimo/i.test(t) &&
    /(total (da|desta) fatura|fatura anterior|resumo da fatura|limite (total|de cr[eé]dito))/i.test(t)
  )
}

export function parseFaturaCartao(pages: PdfPage[], todayIso?: string): FaturaParseResult {
  const warnings: string[] = []
  const allText = pages.map((p) => itemsToLines(p.items).join('\n')).join('\n')
  const bank = detectBank(allText)
  const closing = findClosingDate(allText) ?? todayIso ?? new Date().toISOString().slice(0, 10)
  const cy = Number(closing.slice(0, 4))
  const cm = Number(closing.slice(5, 7))

  const drafts: TransactionDraft[] = []
  let seq = 0
  let skipSection = false
  let statedTotalCents: number | null = null
  let lastDraft: TransactionDraft | null = null
  let skippedPayments = 0
  let currentLast4: string | null = null
  const last4s = new Set<string>()
  const LAST4 = /(?:\bfinal\s*(\d{4})\b|\b\d{4}[.\s]?[X*•]{4}[.\s]?[X*•]{4}[.\s]?(\d{4})\b)/i

  const purchaseYear = (m: number, d: number) => {
    const y = m > cm || (m === cm && d > Number(closing.slice(8, 10)) + 3) ? cy - 1 : cy
    return y
  }

  for (const page of pages) {
    for (const col of splitColumns(page)) {
      for (const line of itemsToLines(col)) {
        const l4 = line.match(LAST4)
        if (l4 && !TX_NUMERIC.test(line)) {
          currentLast4 = l4[1] ?? l4[2] ?? null
          if (currentLast4) last4s.add(currentLast4)
        }
        const total = line.match(STATED_TOTAL)
        if (total) {
          statedTotalCents = centsOf(total[1], total[2]!)
          lastDraft = null
          continue
        }
        if (SECTION_SKIP.test(line)) {
          skipSection = true
          lastDraft = null
          continue
        }
        if (SECTION_INCLUDE.test(line) && !TX_NUMERIC.test(line)) {
          skipSection = false
          lastDraft = null
          continue
        }

        const iof = line.match(IOF_LINE)
        if (iof && !skipSection) {
          const cents = centsOf(iof[2], iof[3]!)
          if (cents > 0) {
            seq += 1
            drafts.push({
              tempId: `fc-${seq}`,
              date: closing,
              amountCents: cents,
              kind: 'debit',
              descriptionRaw: 'IOF compras internacionais',
              accountHint: bank ? `Cartão ${bank}` : null,
            })
          }
          lastDraft = null
          continue
        }

        let day: number, month: number, desc: string, sign: string | undefined, num: string
        const mNum = line.match(TX_NUMERIC)
        const mName = mNum ? null : line.match(TX_MONTHNAME)
        if (mNum) {
          day = Number(mNum[1])
          month = Number(mNum[2])
          desc = mNum[3]!
          sign = mNum[4]
          num = mNum[5]!
        } else if (mName) {
          day = Number(mName[1])
          month = MONTHS[mName[2]!.toLowerCase()]!
          desc = mName[3]!
          sign = mName[4]
          num = mName[5]!
        } else {
          // Itaú: linha abaixo do lançamento com "categoria CIDADE" (ex.: "transporte SAO PAULO")
          const cat = line.match(/^([a-zà-ÿ]+(?: [a-zà-ÿ]+)?)\s+([A-ZÀ-Ýa-zà-ÿ].*)$/)
          if (cat && lastDraft && !lastDraft.categoryHint) {
            const hint = cat[1]!
            if (!/^(outros|servi[cç]os|diversos)$/i.test(hint)) lastDraft.categoryHint = hint
            lastDraft.cityHint = cat[2]!.trim()
          }
          lastDraft = null
          continue
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) continue
        if (skipSection) continue

        desc = desc.replace(/\s+/g, ' ').trim()
        if (PAYMENT_DESC.test(desc)) {
          skippedPayments++
          lastDraft = null
          continue
        }

        // Parcela no fim da descrição: "AMAZON BR 09/10", "CAMPIPARC01/03"
        let date = iso(purchaseYear(month, day), month, day)
        const inst = desc.match(/(?:PARC\s*|\s)(\d{1,2})\/(\d{1,2})$/i)
        if (inst) {
          const n = Number(inst[1])
          const of = Number(inst[2])
          if (n >= 1 && of >= 2 && n <= of && of <= 48) {
            desc = `${desc.slice(0, inst.index).replace(/\s*PARC$/i, '').trim()} (parcela ${n}/${of})`
            // cobra-se no mês da parcela: data da compra + (n−1) meses
            date = addMonths(Number(date.slice(0, 4)), month, day, n - 1)
          }
        }

        const cents = centsOf(sign, num)
        if (cents === 0) continue
        seq += 1
        const draft: TransactionDraft = {
          tempId: `fc-${seq}`,
          date,
          amountCents: Math.abs(cents),
          kind: cents < 0 ? 'credit' : 'debit',
          descriptionRaw: desc,
          accountHint: bank ? `Cartão ${bank}` : null,
          cardLast4: currentLast4,
        }
        drafts.push(draft)
        lastDraft = draft
      }
    }
  }

  const computedTotalCents = drafts.reduce((s, d) => s + (d.kind === 'debit' ? d.amountCents : -d.amountCents), 0)
  const fmt = (c: number) =>
    (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  if (drafts.length === 0) {
    warnings.push('Não encontrei lançamentos nesta fatura. Se o PDF for uma imagem escaneada, tente importar como print.')
  } else if (statedTotalCents != null) {
    const diff = computedTotalCents - statedTotalCents
    if (Math.abs(diff) <= 1) {
      warnings.push(`Conferido: a soma dos ${drafts.length} lançamentos (${fmt(computedTotalCents)}) bate com o total da fatura.`)
    } else {
      warnings.push(
        `Atenção: a soma lida (${fmt(computedTotalCents)}) difere do total da fatura (${fmt(statedTotalCents)}) em ${fmt(Math.abs(diff))}. Confira se faltou algum lançamento.`,
      )
    }
  }
  if (skippedPayments > 0) {
    warnings.push(`${skippedPayments} pagamento(s) da fatura anterior ignorado(s): já aparecem como saída na sua conta.`)
  }

  // IOF e lançamentos antes de achar o final herdam o primeiro cartão encontrado
  const first4 = [...last4s][0] ?? null
  for (const d of drafts) if (!d.cardLast4) d.cardLast4 = first4
  return { drafts, warnings, bank, closingDate: closing, statedTotalCents, computedTotalCents, cardLast4s: [...last4s] }
}
