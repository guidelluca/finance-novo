/**
 * Prints da tela "Minhas faturas" do app PicPay (cartão de crédito):
 *   cabeçalho "Quarta, 28 de outubro" → itens: nome · [Parcela 1 de 3] · horário "13h31" · valor "R$ 6,20".
 * Vários prints sobrepostos viram uma lista só: a mesma compra (data + horário + valor) entra uma vez.
 * Item no topo de um print sem cabeçalho de data pega a data do mesmo item em outro print
 * (ou a do último cabeçalho do print anterior).
 */
import type { OcrLine, OcrPage } from '@/parsers/screenshotOcrParse'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
}
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const HEADER = /^(segunda|terca|quarta|quinta|sexta|sabado|domingo)\s*,?\s*(\d{1,2})\s+de\s+([a-z]+)/
const TIME = /(?:^|\s)([0-9oOlIi]{1,2})h([0-9oOlIi]{2})(?=\s|$)/
const AMOUNT = /([+\-−–]\s*)?R\s?[$S5]\s*(\d{1,3}(?:\.\d{3})*,\d{2})/
const PARCELA = /^parcela\s+(\d{1,2})\s+de\s+(\d{1,2})$/
const UI = /^(minhas faturas|op[cç][oõ]es de fatura|pr[oó]ximas faturas|hist[oó]rico de faturas|d[eé]bito autom[aá]tico|ativado|data de vencimento|todo dia \d+|central de ajuda|fatura (atual|aberta|fechada)|pagamento da fatura)$/

export function looksLikePicpayFatura(pages: OcrPage[]): boolean {
  const all = fold(pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n'))
  const times = (all.match(/\b[0-9oli]{1,2}h[0-9oli]{2}\b/g) ?? []).length
  const headers = (all.match(/(segunda|terca|quarta|quinta|sexta|sabado|domingo)\s*,?\s*\d{1,2} de [a-z]+/g) ?? []).length
  return /minhas faturas/.test(all) || (times >= 3 && headers >= 1)
}

const digits = (s: string) => s.replace(/[oO]/g, '0').replace(/[lIi]/g, '1')

type Item = {
  page: number
  date: string | null
  desc: string
  time: string | null
  cents: number | null
  credit: boolean
  inst: string | null
}

function yearFor(month: number, day: number, today: string): string {
  let y = Number(today.slice(0, 4))
  const iso = (yy: number) => `${yy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (iso(y) > today) y -= 1
  return iso(y)
}

/** linhas → linhas visuais (mesma altura), sem ícones e lixo da coluna da esquerda */
function rowsOf(page: OcrPage): string[] {
  const lines = page.lines.filter((l) => l.text.trim() && l.y1 > page.height * 0.06)
  const timeX = lines.filter((l) => TIME.test(` ${l.text} `)).map((l) => l.x0)
  const textX = timeX.length ? timeX.sort((a, b) => a - b)[Math.floor(timeX.length / 2)]! : null
  const useful = lines.filter((l) => {
    const t = l.text.trim()
    if (AMOUNT.test(t)) return true
    if (textX !== null && l.x0 < textX - 60) return HEADER.test(fold(t)) // ícones à esquerda; cabeçalho de data começa mais à esquerda
    return t.length > 3 || /\*/.test(t)
  })
  const sorted = [...useful].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const groups: OcrLine[][] = []
  for (const l of sorted) {
    const mid = (l.y0 + l.y1) / 2
    const g = groups.find((gr) => mid >= Math.min(...gr.map((x) => x.y0)) - 4 && mid <= Math.max(...gr.map((x) => x.y1)) + 4)
    if (g) g.push(l)
    else groups.push([l])
  }
  return groups.map((g) =>
    g
      .sort((a, b) => a.x0 - b.x0)
      .map((x) => x.text.trim())
      .join('  '),
  )
}

export function parsePicpayFaturaPrints(pages: OcrPage[], today: string): ParseResult {
  const items: Item[] = []
  const lastHeaderOfPage: (string | null)[] = []

  pages.forEach((page, pi) => {
    let date: string | null = null
    let open: Item | null = null
    const close = () => {
      if (open && open.cents !== null && open.desc) items.push(open)
      open = null
    }
    for (const raw of rowsOf(page)) {
      const t = raw.replace(/\s*[>›»]\s*$/, '').trim()
      const f = fold(t)
      const h = f.match(HEADER)
      if (h && !AMOUNT.test(t)) {
        close()
        const m = MONTHS[h[3]!.replace('ç', 'c')]
        date = m ? yearFor(m, Number(h[2]), today) : date
        continue
      }
      if (UI.test(f)) {
        if (/^pagamento da fatura$/.test(f) && open) continue // subtítulo de "Pagamento de Fatura"
        close()
        continue
      }
      const p = f.match(PARCELA)
      if (p && open) {
        open.inst = `${p[1]}/${p[2]}`
        continue
      }
      const tm = ` ${t} `.match(TIME)
      const am = t.match(AMOUNT)
      const textPart = t.replace(AMOUNT, ' ').replace(TIME, ' ').replace(/\s+/g, ' ').trim()
      if ((tm || am) && textPart.length < 3) {
        if (!open) continue
        if (tm) open.time = `${digits(tm[1]!).padStart(2, '0')}:${digits(tm[2]!)}`
        if (am) {
          open.cents = Math.round(Number(am[2]!.replace(/\./g, '').replace(',', '.')) * 100)
          open.credit = /\+/.test(am[1] ?? '')
          close()
        }
        continue
      }
      // nova descrição: fecha o item anterior (se ficou sem valor, foi cortado no fim do print)
      close()
      open = { page: pi, date, desc: textPart || t, time: tm ? `${digits(tm[1]!).padStart(2, '0')}:${digits(tm[2]!)}` : null, cents: null, credit: false, inst: null }
      if (am) {
        open.cents = Math.round(Number(am[2]!.replace(/\./g, '').replace(',', '.')) * 100)
        open.credit = /\+/.test(am[1] ?? '')
        close()
      }
    }
    close()
    lastHeaderOfPage.push(date)
  })

  // item sem data (topo do print): mesma compra em outro print com data, senão o último cabeçalho do print anterior
  const descKey = (i: Item) => fold(i.desc).replace(/[^a-z0-9]/g, '').slice(0, 14)
  let inferred = 0
  for (const it of items) {
    if (it.date) continue
    const twin = items.find((o) => o.date && o.cents === it.cents && (it.time ? o.time === it.time : descKey(o) === descKey(it) && o.inst === it.inst))
    if (twin) it.date = twin.date
    else {
      for (let k = it.page - 1; k >= 0 && !it.date; k--) it.date = lastHeaderOfPage[k] ?? null
      if (it.date) inferred += 1
    }
  }

  // vários prints da mesma tela: a mesma compra (data + horário + valor) entra uma vez
  const seen = new Map<string, number>()
  const drafts: TransactionDraft[] = []
  let dup = 0
  let noDate = 0
  for (const it of items) {
    if (!it.date) {
      noDate += 1
      continue
    }
    const key = it.time ? `${it.date}|${it.time}|${it.cents}` : `${it.date}|${descKey(it)}|${it.cents}|${it.inst ?? ''}`
    const firstPage = seen.get(key)
    if (firstPage !== undefined && firstPage !== it.page) {
      dup += 1
      continue
    }
    seen.set(key, it.page)
    // "Lojas Renner Fparc01/03", "Adidas Parqueparc01/03": tira a parcela colada no nome (o OCR troca 0 por O)
    const base = it.desc.replace(/\s?parc\s?[0-9oOlIi]{1,3}\/[0-9oOlIi]{1,3}$/i, '').trim()
    const isPayment = /pagamento de fatura/i.test(base)
    drafts.push({
      tempId: `ppf-${drafts.length + 1}`,
      date: it.date,
      amountCents: it.cents!,
      kind: it.credit ? 'credit' : 'debit',
      descriptionRaw: it.inst ? `${base} (parcela ${it.inst})` : base,
      accountHint: 'Cartão PicPay',
      // pagamento da fatura aparece na fatura mas não é compra nem renda: o lado do banco já registra
      excluded: isPayment,
      reviewFlags: isPayment ? ['pagamento da fatura: não é compra (o débito aparece no extrato do banco)'] : undefined,
    })
  }

  const warnings = [`Prints da fatura PicPay: ${drafts.length} lançamento(s) de ${pages.length} print(s).`]
  if (dup) warnings.push(`${dup} repetido(s) entre prints sobrepostos foram juntados.`)
  if (inferred) warnings.push(`${inferred} item(ns) no topo de um print sem data visível: usei a data do print anterior. Confira.`)
  if (noDate) warnings.push(`${noDate} item(ns) sem data nenhuma foram ignorados: inclua um print com o cabeçalho do dia.`)
  return { drafts, warnings }
}
