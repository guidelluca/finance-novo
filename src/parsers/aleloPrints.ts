/**
 * Prints do extrato do app Alelo (VR / vale-refeição):
 *   nome (1–2 linhas) · "05/08"            |  "- R$ 10,29"  (à direita, no meio do item)
 *   "Seu Benefício Caiu" · "28/08"         |  "+ R$ 1.150,00"
 * Topo do 1.º print: "Saldo disponível", "Próximo benefício", "Últimas transações", "120 dias".
 * Fim da lista: "Consulta efetuada em 09/11/2026 às 21h22" (dá o ano das datas).
 * Vários prints sobrepostos: cada compra (data + valor + nome) entra uma vez; duas compras iguais
 * no mesmo print continuam duas.
 */
import type { OcrLine, OcrPage } from '@/parsers/screenshotOcrParse'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** "- R$ 10,29", "+ R$ 1.150,00" — o Alelo sempre mostra o sinal */
const AMOUNT_LINE = /^([+\-−–—~])\s*R\s?[$S5]\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/
/** "05/08"; o OCR às vezes lê "11" como "n" ("07/n") e 0/1 como O/l */
const DATE_ONLY = /^([0-9oOlIin]{1,2})\s?\/\s?([0-9oOlIin]{1,2})$/
const CONSULTA = /consulta efetuada em (\d{2})\/(\d{2})\/(\d{4})/

const STRONG = /seu beneficio caiu|proximo beneficio|gasto sugerido por dia|precisa de extratos com mais de 120 dias|ofertas exclusivas|ultimo beneficio/

export function looksLikeAleloExtrato(pages: OcrPage[]): boolean {
  const all = fold(pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n'))
  if (STRONG.test(all)) return true
  // print do meio da lista: título "Extrato" + itens com data embaixo do nome e valor com sinal
  if (/cartoes|minhas faturas|compras a vista/.test(all)) return false
  return pages.some((p) => {
    const title = p.lines.some((l) => l.y0 < p.height * 0.15 && /^extrato$/.test(fold(l.text)))
    const amounts = p.lines.filter((l) => AMOUNT_LINE.test(l.text.replace(/\s+/g, ' ').trim())).length
    const dates = p.lines.filter((l) => DATE_ONLY.test(l.text.trim())).length
    return title && amounts >= 3 && dates >= 3
  })
}

const dPart = (t: string) => (t === 'n' ? '11' : t.replace(/[oO]/g, '0').replace(/[lIi]/g, '1'))
const centsOf = (num: string) => Math.round(Number(num.replace(/\./g, '').replace(',', '.')) * 100)
const center = (l: OcrLine) => (l.y0 + l.y1) / 2

function isoFrom(dd: number, mm: number, ref: string): string | null {
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  let y = Number(ref.slice(0, 4))
  const mk = (yy: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  if (mk(y) > ref) y -= 1 // sem ano no print: a ocorrência mais recente até a data da consulta
  const d = new Date(Date.UTC(y, mm - 1, dd))
  return d.getUTCMonth() === mm - 1 ? mk(y) : null
}

type Item = { page: number; date: string; desc: string; cents: number; credit: boolean }

export function parseAleloPrints(pages: OcrPage[], today: string): ParseResult {
  // data da consulta (rodapé) vale para todos os prints do mesmo envio
  let ref = today
  for (const p of pages) {
    for (const l of p.lines) {
      const m = fold(l.text).match(CONSULTA)
      if (m) {
        const iso = `${m[3]}-${m[2]}-${m[1]}`
        if (iso <= today) ref = iso
      }
    }
  }

  const items: Item[] = []
  const cutCents: number[] = []
  pages.forEach((page, pi) => {
    const lines = [...page.lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    const listStart = lines.find((l) => /^(ultimas transacoes|120 dias)$/.test(fold(l.text)))
    const title = lines.find((l) => l.y0 < page.height * 0.2 && /^extrato$/.test(fold(l.text)))
    const footer = lines.find((l) => /^consulta efetuada|^precisa de extratos/.test(fold(l.text)))
    const top = listStart ? listStart.y1 + 4 : title ? title.y1 + 4 : page.height * 0.08
    const bottom = footer ? footer.y0 - 4 : page.height
    const area = lines.filter((l) => l.y0 >= top && l.y1 <= bottom)
    const anchors = area.filter((l) => AMOUNT_LINE.test(l.text.replace(/\s+/g, ' ').trim()))
    const maxX = Math.max(1, ...area.map((l) => l.x0))

    // meia altura de um item (metade da distância típica entre valores): o 1.º e o último item do print
    // não engolem pedaços de itens cortados na borda
    const gaps = anchors.slice(1).map((x, i) => center(x) - center(anchors[i]!)).sort((x, y) => x - y)
    const half = gaps.length ? gaps[Math.floor(gaps.length / 2)]! / 2 : page.height * 0.045
    anchors.forEach((a, k) => {
      const from = Math.max(k === 0 ? top : (center(anchors[k - 1]!) + center(a)) / 2, center(a) - half)
      const to = Math.min(k === anchors.length - 1 ? bottom : (center(a) + center(anchors[k + 1]!)) / 2, center(a) + half)
      const m = a.text.replace(/\s+/g, ' ').trim().match(AMOUNT_LINE)!
      const cents = centsOf(m[2]!)
      if (!cents) return
      let date: string | null = null
      const name: OcrLine[] = []
      for (const l of area) {
        if (l === a || center(l) < from || center(l) >= to) continue
        const t = l.text.replace(/\s+/g, ' ').trim()
        const dm = t.match(DATE_ONLY)
        if (dm) {
          const iso = isoFrom(Number(dPart(dm[1]!)), Number(dPart(dm[2]!)), ref)
          if (iso) {
            date = iso
            continue
          }
        }
        if (l.x0 < maxX * 0.12) continue // ícone à esquerda ("UI", "Q")
        if (l.x0 >= a.x0 - 10) continue
        if (!/[a-z0-9]{2,}/i.test(t)) continue
        name.push(l)
      }
      const desc = name
        .sort((x, y) => x.y0 - y.y0 || x.x0 - y.x0)
        .map((l) => l.text.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!desc || !date) {
        cutCents.push(cents)
        return
      }
      items.push({ page: pi, date, desc, cents, credit: m[1] === '+' })
    })
  })

  // prints sobrepostos: por chave, fica o maior número de ocorrências visto num print só
  const key = (i: Item) => `${i.date}|${i.cents}|${i.credit ? 'c' : 'd'}|${fold(i.desc).replace(/[^a-z0-9]/g, '').slice(0, 8)}`
  const perPage = new Map<string, Map<number, number>>()
  for (const it of items) {
    const m = perPage.get(key(it)) ?? new Map<number, number>()
    m.set(it.page, (m.get(it.page) ?? 0) + 1)
    perPage.set(key(it), m)
  }
  const taken = new Map<string, number>()
  const kept: Item[] = []
  let dup = 0
  for (const it of items) {
    const k = key(it)
    const n = taken.get(k) ?? 0
    if (n >= Math.max(...perPage.get(k)!.values())) {
      dup += 1
      continue
    }
    taken.set(k, n + 1)
    kept.push(it)
  }
  kept.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const drafts: TransactionDraft[] = kept.map((it, i) => {
    const benefit = it.credit && /beneficio/.test(fold(it.desc))
    return {
      tempId: `alelo-${i + 1}`,
      date: it.date,
      amountCents: it.cents,
      kind: it.credit ? 'credit' : 'debit',
      descriptionRaw: benefit ? 'Crédito VR Alelo (benefício)' : it.desc,
      categoryHint: benefit ? 'Benefício' : null,
      accountHint: 'VR Alelo',
    }
  })
  const cut = cutCents.filter((c) => !kept.some((k) => k.cents === c)).length
  const credits = kept.filter((i) => i.credit).reduce((s, i) => s + i.cents, 0)
  const debits = kept.filter((i) => !i.credit).reduce((s, i) => s + i.cents, 0)
  const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const warnings = [
    `Prints do VR Alelo: ${drafts.length} lançamento(s) de ${pages.length} print(s) — entradas ${fmt(credits)}, gastos ${fmt(debits)}.`,
  ]
  if (dup) warnings.push(`${dup} repetido(s) entre prints sobrepostos foram juntados.`)
  if (cut) warnings.push(`${cut} item(ns) cortado(s) na borda do print foram ignorados: se faltar algum, mande um print que mostre o item inteiro.`)
  return { drafts, warnings }
}
