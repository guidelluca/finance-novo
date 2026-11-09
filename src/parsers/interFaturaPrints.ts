/**
 * Prints da tela "Cartões" do app Banco Inter (cartão de crédito), abas:
 *   "Compras à vista":  nome (1–2 linhas) · categoria do Inter   |  "-R$ 282,50" · "08/11" (à direita)
 *   "Parcelamentos":    nome (1–2 linhas) · "25/10"             |  "R$ 1.130,02" · "3x de R$ 376,68"
 * O valor fica no meio vertical de cada item: os limites entre itens são os pontos médios entre valores.
 * Parcelamento vira uma linha por parcela ("X (parcela 2/3)"), cada uma no mês em que é cobrada —
 * igual à leitura da fatura em PDF, para as duas fontes não contarem a mesma compra duas vezes.
 * Vários prints sobrepostos: a mesma compra (data + valor + nome) entra uma vez.
 */
import type { OcrLine, OcrPage } from '@/parsers/screenshotOcrParse'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** "-R$ 282,50", "R$ 1.130,02", "+ R$ 10,00" — a linha inteira é o valor */
const AMOUNT_LINE = /^([+\-−–—~]\s*)?R\s?[$S5]\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/
/** "3x de R$ 376,68" */
const INSTALLMENTS = /^(\d{1,2})\s?[xX]\s*de\s*R\s?[$S5]\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/
/** "08/11" sozinho na linha (OCR às vezes troca 0/O e 1/l) */
const DATE_ONLY = /^([0-9oOlI]{2})\s?\/\s?([0-9oOlI]{2})$/
const UI = /^(compras a vista|parcelamentos|mostrar todas|utilizado|disponivel|desbloquear|cartoes|wearables|parcelar|saldo total|parcele|carteira|digital|opcoes de aumento de limite)$/
/** Categorias que o Inter mostra embaixo do nome; "Outros" não ajuda a categorizar */
const INTER_CATEGORIES = /^(outros|transporte|supermercado|restaurantes?|alimenta[cç][aã]o|servi[cç]os|compras|vestu[aá]rio|sa[uú]de|farm[aá]cia|educa[cç][aã]o|entretenimento|lazer|viagens?|turismo|casa|moradia|tecnologia|eletr[oô]nicos|beleza|pets?|esportes?|combust[ií]vel|assinaturas?|streaming|drogaria|mercado|bares?|delivery)$/i

const digits = (s: string) => s.replace(/[oO]/g, '0').replace(/[lI]/g, '1')
const centsOf = (num: string) => Math.round(Number(num.replace(/\./g, '').replace(',', '.')) * 100)

export function looksLikeInterFatura(pages: OcrPage[]): boolean {
  const all = fold(pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n'))
  const tabs = /compras a vista/.test(all) && /parcelamentos/.test(all)
  const chrome = /parcelar\s*\n?\s*saldo total|wearables|carteira\s*\n?\s*digital|opcoes de aumento de limite/.test(all)
  if (tabs || (chrome && /cartoes/.test(all))) return true
  // print rolado: título "Cartões" + itens "-R$ 12,34" com a data "dd/mm" sozinha na linha
  const lines = pages.flatMap((p) => p.lines.map((l) => l.text.replace(/\s+/g, ' ').trim()))
  const amounts = lines.filter((t) => AMOUNT_LINE.test(t)).length
  const dates = lines.filter((t) => DATE_ONLY.test(t)).length
  return /cartoes/.test(all) && !/minhas faturas/.test(all) && amounts >= 2 && dates >= 2
}

type Item = {
  page: number
  date: string | null
  desc: string
  category: string | null
  cents: number
  credit: boolean
  inst: { n: number; cents: number } | null
}

function isoFromDayMonth(dd: number, mm: number, today: string): string | null {
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  let y = Number(today.slice(0, 4))
  const mk = (yy: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  // sem ano no print: a compra é a ocorrência mais recente que não está no futuro
  if (mk(y) > today) y -= 1
  const d = new Date(Date.UTC(y, mm - 1, dd))
  if (d.getUTCMonth() !== mm - 1) return null
  return mk(y)
}

function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const first = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** "99 SAO PAULO BRA" → "99"; "PANDURATA VAREJO DE AL SAO PAULO BRA" → "PANDURATA VAREJO DE AL" */
function cleanName(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+BRA$/i, '')
    .replace(/\s+(S[AÃ]O PAULO|SANTO ANDR[EÉ]|S[AÃ]O BERNARDO DO CAMPO|RIO DE JANEIRO|OSASCO|GUARULHOS|BARUERI|CAMPINAS|CURITIBA|BELO HORIZONTE)$/i, '')
    .trim()
}

const center = (l: OcrLine) => (l.y0 + l.y1) / 2

export function parseInterFaturaPrints(pages: OcrPage[], today: string): ParseResult {
  const items: Item[] = []
  const cutCents: number[] = []

  pages.forEach((page, pi) => {
    const lines = [...page.lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    // área da lista: abaixo das abas "Compras à vista | Parcelamentos", acima de "Mostrar todas"
    const tabs = lines.find((l) => /compras a vista|parcelamentos/.test(fold(l.text)))
    const more = lines.find((l) => /^mostrar todas$/.test(fold(l.text)))
    // print rolado (abas fora da tela): começa abaixo do título fixo "Cartões"
    const header = lines.find((l) => l.y0 < page.height * 0.2 && /cartoes$/.test(fold(l.text)))
    const top = tabs ? tabs.y1 + 4 : header ? header.y1 + 4 : page.height * 0.08
    const bottom = more ? more.y0 - 4 : page.height
    const area = lines.filter((l) => l.y0 >= top && l.y1 <= bottom && !UI.test(fold(l.text)))
    const maxX = Math.max(1, ...area.map((l) => l.x0))

    const anchors = area.filter((l) => AMOUNT_LINE.test(l.text.replace(/\s+/g, ' ').trim()))
    anchors.forEach((a, k) => {
      const from = k === 0 ? top : (center(anchors[k - 1]!) + center(a)) / 2
      const to = k === anchors.length - 1 ? bottom : (center(a) + center(anchors[k + 1]!)) / 2
      const block = area.filter((l) => l !== a && center(l) >= from && center(l) < to)

      const m = a.text.replace(/\s+/g, ' ').trim().match(AMOUNT_LINE)!
      const sign = (m[1] ?? '').trim()
      const cents = centsOf(m[2]!)
      if (!cents) return

      let inst: Item['inst'] = null
      let date: string | null = null
      let dateLine: OcrLine | null = null
      const rest: OcrLine[] = []
      for (const l of block) {
        const t = l.text.replace(/\s+/g, ' ').trim()
        const im = t.match(INSTALLMENTS)
        if (im) {
          inst = { n: Number(im[1]), cents: centsOf(im[2]!) }
          continue
        }
        const dm = t.match(DATE_ONLY)
        if (dm) {
          const iso = isoFromDayMonth(Number(digits(dm[1]!)), Number(digits(dm[2]!)), today)
          if (iso) {
            date = iso
            dateLine = l
            continue
          }
        }
        // ícone à esquerda ("...", "G", carro, carrinho) e restos de 1–2 caracteres
        if (l.x0 < maxX * 0.12 && t.length <= 3) continue
        if (!/[a-z0-9]{2,}/i.test(t)) continue
        // nada à direita do valor além da data/parcela
        if (l.x0 >= a.x0 - 10) continue
        rest.push(l)
      }
      rest.sort((x, y) => (Math.abs(x.y0 - y.y0) < 12 ? x.x0 - y.x0 : x.y0 - y.y0))

      // à vista: a última linha à esquerda é a categoria do Inter (fica na mesma altura da data)
      let category: string | null = null
      if (!inst && rest.length >= 2) {
        const last = rest[rest.length - 1]!
        const t = last.text.trim()
        const sameRowAsDate = dateLine ? Math.abs(center(last) - center(dateLine)) < 30 : false
        if (INTER_CATEGORIES.test(t) || (sameRowAsDate && t.split(/\s+/).length <= 2)) {
          category = t
          rest.pop()
        }
      }
      const desc = cleanName(rest.map((l) => l.text.trim()).join(' '))
      // item cortado na borda do print (sem nome ou sem data)
      if (!desc || !date) {
        cutCents.push(cents)
        return
      }
      items.push({ page: pi, date, desc, category, cents, credit: sign === '+', inst })
    })
  })

  // vários prints: por chave, fica o maior número de ocorrências visto num print só
  const key = (i: Item) => `${i.date}|${i.cents}|${fold(i.desc).replace(/[^a-z0-9]/g, '').slice(0, 8)}|${i.inst ? 'p' : 'v'}`
  const perPage = new Map<string, Map<number, number>>()
  for (const it of items) {
    const k = key(it)
    const m = perPage.get(k) ?? new Map<number, number>()
    m.set(it.page, (m.get(it.page) ?? 0) + 1)
    perPage.set(k, m)
  }
  const taken = new Map<string, number>()
  const kept: Item[] = []
  let dup = 0
  for (const it of items) {
    const k = key(it)
    const allowed = Math.max(...perPage.get(k)!.values())
    const n = taken.get(k) ?? 0
    if (n >= allowed) {
      dup += 1
      continue
    }
    taken.set(k, n + 1)
    kept.push(it)
  }

  const drafts: TransactionDraft[] = []
  let futureInst = 0
  for (const it of kept) {
    const isPayment = /pagamento|pgto.*fatura/i.test(it.desc)
    const hint = it.category && !/^outros$/i.test(it.category) ? it.category : null
    if (it.inst && it.inst.n >= 2 && it.inst.n <= 48) {
      for (let p = 1; p <= it.inst.n; p++) {
        const date = addMonths(it.date!, p - 1)
        if (date > today) futureInst += 1
        drafts.push({
          tempId: `itf-${drafts.length + 1}`,
          date,
          amountCents: it.inst.cents,
          kind: 'debit',
          descriptionRaw: `${it.desc} (parcela ${p}/${it.inst.n})`,
          categoryHint: hint,
          accountHint: 'Cartão Inter',
        })
      }
      continue
    }
    drafts.push({
      tempId: `itf-${drafts.length + 1}`,
      date: it.date!,
      amountCents: it.cents,
      kind: it.credit ? 'credit' : 'debit',
      descriptionRaw: it.desc,
      categoryHint: hint,
      accountHint: 'Cartão Inter',
      // pagamento da fatura não é compra nem renda: o débito já aparece no extrato do banco
      excluded: isPayment,
      reviewFlags: isPayment ? ['pagamento da fatura: não é compra (o débito aparece no extrato do banco)'] : undefined,
    })
  }

  // cortado num print mas inteiro em outro: não é perda
  const cut = cutCents.filter((c) => !kept.some((k) => k.cents === c)).length
  const warnings = [`Prints da fatura Inter: ${drafts.length} lançamento(s) de ${pages.length} print(s).`]
  if (kept.some((i) => i.inst)) {
    warnings.push(
      `Parcelamentos viraram uma linha por parcela, cada uma no mês em que é cobrada${futureInst ? ` (${futureInst} parcela(s) em meses futuros)` : ''}.`,
    )
  }
  if (dup) warnings.push(`${dup} repetido(s) entre prints sobrepostos foram juntados.`)
  if (cut) warnings.push(`${cut} item(ns) cortado(s) na borda do print foram ignorados: se faltar algum, mande um print que mostre o item inteiro.`)
  return { drafts, warnings }
}
