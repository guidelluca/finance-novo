/**
 * Fatura do cartão Banco Inter em PDF.
 *   "Despesas da fatura" → por cartão ("CARTÃO 5555****1329"):
 *     "18 de out. 2026  PAGAMENTO ON LINE  -  + R$ 119,99"
 *     "14 de out. 2026  Ticketmaster*TICKETMAS (Parcela 01 de 03)  -  R$ 200,00"
 *     "Total CARTÃO 5555****1329  R$ 5,74"
 *   "Próxima fatura" → parcelas que vêm na fatura seguinte (só para conferir, não grava).
 *
 * Conferências (todas precisam bater; a que não bater vira aviso com a diferença):
 *   1. soma das compras de cada cartão = "Total CARTÃO ****"
 *   2. soma dos totais por cartão = "Despesas do mês"
 *   3. tarifas/juros/IOF lidos = "Valor total de juros e encargos"
 *   4. "Despesas do mês" − "Valor antecipado" = "Fatura atual" = valor a pagar do rodapé/boleto
 *   5. cada parcela "02 de 03" da próxima fatura tem a "01 de 03" correspondente nesta
 */
import type { FaturaParseResult, PdfItem, PdfPage } from './faturaCartao'
import type { TransactionDraft } from './types'

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
}
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const MONEY = String.raw`R\$\s?(\d{1,3}(?:\.\d{3})*,\s?\d{2})`
const ROW = new RegExp(
  String.raw`^(\d{1,2}) de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.? (\d{4}) (.+?)\s+([+\-−]\s*)?${MONEY}$`,
  'i',
)
const CARD = /^cart[aã]o\s+(\d{4})\*{2,}(\d{4})$/i
const CARD_TOTAL = new RegExp(String.raw`^total cart[aã]o\s+\d{4}\*{2,}(\d{4})\s+${MONEY}$`, 'i')
const PARCELA = /\s*\(?\s*parcela\s+(\d{1,2})\s+de\s+(\d{1,2})\s*\)?\s*$/i
const FEE = /^(rotativo|multa|encargos?|iof|juros|tarifa|anuidade|seguro|saldo financiado)/i
const PAYMENT = /^(pagamento|pgto|pag\s?fatura)/i

export function looksLikeInterFaturaPdf(text: string): boolean {
  const t = fold(text)
  const inter = /banco inter s\/?a|bancointer\.com\.br|inter\.co\/|inter loop|super app do inter/.test(t)
  return inter && /despesas da fatura|resumo da fatura|total da sua fatura/.test(t)
}

/** Linhas da página, juntando pedaços colados ("P" + "AGAMENTO" → "PAGAMENTO"). */
function pageLines(page: PdfPage): string[] {
  const sorted = page.items.filter((i) => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: PdfItem[][] = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row[0]!.y - it.y) <= 2.5) row.push(it)
    else rows.push([it])
  }
  return rows.map((r) => {
    r.sort((a, b) => a.x - b.x)
    let s = ''
    let end = -Infinity
    for (const it of r) {
      const gap = it.x - end
      s += s && gap > 1.2 ? ` ${it.str}` : it.str
      end = it.x + it.w
    }
    return s.replace(/\s+/g, ' ').trim()
  })
}

const cents = (num: string) => Math.round(Number(num.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')) * 100)
const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function firstMoneyAfter(lines: string[], label: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(fold(lines[i]!))) continue
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const m = lines[k]!.match(new RegExp(MONEY))
      if (m) return cents(m[1]!)
    }
  }
  return null
}

export function parseInterFaturaPdf(pages: PdfPage[]): FaturaParseResult {
  const lines = pages.flatMap(pageLines)
  const warnings: string[] = []
  const drafts: TransactionDraft[] = []
  const cardTotals = new Map<string, number>()
  const readByCard = new Map<string, number>()
  const nextInstallments: { desc: string; n: number; of: number; cents: number }[] = []
  let card: string | null = null
  let section: 'none' | 'despesas' | 'proxima' = 'none'
  let feesRead = 0
  let payments = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = fold(line)
    if (/^despesas da fatura$/.test(f)) {
      section = 'despesas'
      continue
    }
    if (/^proxima fatura$/.test(f)) {
      section = 'proxima'
      continue
    }
    if (/^fale com a gente$/.test(f)) section = 'none'

    if (section === 'proxima') {
      // "Ticketmaster*TICKETMAS (Parcela 02 de" · "R$ 200,00" · "03)" (descrição quebrada em 2 linhas)
      const pm = f.match(/^(?:utilizado: disponivel: )?(.+?)\s*\(parcela (\d{1,2}) de$/)
      if (pm) {
        const raw = line.replace(/^Utilizado:\s*Disponível:\s*/i, '')
        const desc = raw.replace(/\s*\(\s*parcela.*$/i, '').trim()
        const money = lines.slice(i, i + 3).map((l) => l.match(new RegExp(`^${MONEY}$`))).find(Boolean)
        const of = lines.slice(i + 1, i + 4).map((l) => l.match(/^(\d{1,2})\)$/)).find(Boolean)
        if (money && of) nextInstallments.push({ desc, n: Number(pm[2]), of: Number(of[1]), cents: cents(money[1]!) })
      }
      continue
    }
    if (section !== 'despesas') continue

    const cm = line.match(CARD)
    if (cm) {
      card = cm[2]!
      continue
    }
    const tm = line.match(CARD_TOTAL)
    if (tm) {
      cardTotals.set(tm[1]!, cents(tm[2]!))
      continue
    }
    const m = line.match(ROW)
    if (!m) continue
    const day = Number(m[1])
    const month = MONTHS[fold(m[2]!).slice(0, 3)]!
    const year = Number(m[3])
    // coluna "Beneficiário" vem como "-" quando vazia
    let desc = m[4]!.replace(/\s+-$/, '').trim()
    const sign = (m[5] ?? '').trim()
    const value = cents(m[6]!)
    if (!value) continue
    let date = `${year}-${pad(month)}-${pad(day)}`
    const inst = desc.match(PARCELA)
    if (inst) {
      const n = Number(inst[1])
      const of = Number(inst[2])
      desc = `${desc.slice(0, inst.index).trim()} (parcela ${n}/${of})`
      // a data impressa é a da compra; a parcela n é cobrada n−1 meses depois (igual às outras faturas)
      if (n > 1) {
        const t = month - 1 + (n - 1)
        const ny = year + Math.floor(t / 12)
        const nm = (t % 12) + 1
        const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
        date = `${ny}-${pad(nm)}-${pad(Math.min(day, last))}`
      }
    }
    // "PICPAY*CVC BRASIL OP" → "PICPAY CVC BRASIL OP": igual ao print do app, para não duplicar
    desc = desc.replace(/\*/g, ' ').replace(/\s+/g, ' ').trim()
    const credit = sign === '+'
    const isPayment = credit && PAYMENT.test(desc)
    if (isPayment) payments += value
    else if (card) readByCard.set(card, (readByCard.get(card) ?? 0) + (credit ? -value : value))
    if (!credit && FEE.test(desc)) feesRead += value
    drafts.push({
      tempId: `ifp-${drafts.length + 1}`,
      date,
      amountCents: value,
      kind: credit ? 'credit' : 'debit',
      descriptionRaw: desc,
      accountHint: 'Cartão Inter',
      cardLast4: card,
      categoryHint: !credit && FEE.test(desc) ? 'Tarifas' : null,
      // pagamento da fatura anterior não é renda: a saída já aparece no extrato da conta
      excluded: isPayment,
      reviewFlags: isPayment ? ['pagamento da fatura: não é compra (o débito aparece no extrato do banco)'] : undefined,
    })
  }

  // ===== conferências =====
  const problems: string[] = []
  const oks: string[] = []
  for (const [c, total] of cardTotals) {
    const read = readByCard.get(c) ?? 0
    if (Math.abs(read - total) <= 1) oks.push(`cartão final ${c}`)
    else problems.push(`Cartão final ${c}: li ${fmt(read)}, a fatura diz ${fmt(total)} (diferença ${fmt(Math.abs(read - total))}).`)
  }
  for (const c of readByCard.keys()) if (!cardTotals.has(c)) problems.push(`Cartão final ${c}: não achei o total impresso para conferir.`)

  const despesas = firstMoneyAfter(lines, /^despesas do mes\b/)
  const antecipado = firstMoneyAfter(lines, /^valor antecipado\b/) ?? 0
  const faturaAtual = firstMoneyAfter(lines, /^fatura atual\b/)
  // rodapé de toda página: "5555****1329 15/11/2026 R$ 582, 42"
  const footer = lines.map((l) => l.match(/\d{4}\*{2,}\d{4} \d{2}\/\d{2}\/\d{4} R\$\s?(\d{1,3}(?:\.\d{3})*,\s?\d{2})$/)).find(Boolean)
  const totalFatura = footer ? cents(footer[1]!) : null
  const encargos = firstMoneyAfter(lines, /^valor total de juros e encargos\b/)
  const sumCards = [...cardTotals.values()].reduce((a, b) => a + b, 0)
  const computed = [...readByCard.values()].reduce((a, b) => a + b, 0)

  if (despesas != null) {
    if (Math.abs(sumCards - despesas) <= 1 && Math.abs(computed - despesas) <= 1) oks.push('despesas do mês')
    else problems.push(`Soma dos lançamentos ${fmt(computed)} ≠ "Despesas do mês" ${fmt(despesas)} (diferença ${fmt(Math.abs(computed - despesas))}).`)
    const expectedAtual = despesas - antecipado
    for (const [label, v] of [['Fatura atual', faturaAtual], ['Valor a pagar do rodapé', totalFatura]] as const) {
      if (v == null) continue
      if (Math.abs(v - expectedAtual) <= 1) continue
      problems.push(`"${label}" ${fmt(v)} ≠ despesas ${fmt(despesas)} − antecipado ${fmt(antecipado)}.`)
    }
    if (faturaAtual != null || totalFatura != null) oks.push('total a pagar')
  }
  if (encargos != null) {
    if (Math.abs(feesRead - encargos) <= 1) oks.push('juros e encargos')
    else problems.push(`Juros, IOF e tarifas lidos somam ${fmt(feesRead)}, a fatura diz ${fmt(encargos)}.`)
  }
  for (const nx of nextInstallments) {
    const key = fold(nx.desc).replace(/[^a-z0-9]/g, '')
    const prev = drafts.find((d) => {
      const m = d.descriptionRaw.match(/\(parcela (\d+)\/(\d+)\)$/)
      return m && Number(m[1]) === nx.n - 1 && Number(m[2]) === nx.of && fold(d.descriptionRaw).replace(/[^a-z0-9]/g, '').startsWith(key.slice(0, 10))
    })
    if (!prev) problems.push(`Próxima fatura traz "${nx.desc}" parcela ${nx.n}/${nx.of}, mas não achei a parcela ${nx.n - 1} nesta.`)
    else if (Math.abs(prev.amountCents - nx.cents) > 2) problems.push(`"${nx.desc}": parcela ${nx.n - 1} de ${fmt(prev.amountCents)} e a próxima de ${fmt(nx.cents)} — confira.`)
  }
  if (nextInstallments.length && !problems.some((p) => p.startsWith('Próxima'))) oks.push('parcelas da próxima fatura')

  if (drafts.length === 0) warnings.push('Não encontrei lançamentos nesta fatura do Inter.')
  else if (problems.length === 0) {
    warnings.push(
      `Fatura Inter conferida (${oks.join(', ')}): ${drafts.length} lançamento(s), ${fmt(computed)} em despesas — bate com o total impresso.`,
    )
  } else {
    warnings.push(`Atenção: ${problems.length} conferência(s) da fatura Inter não bateram. Revise antes de salvar.`, ...problems)
  }
  if (payments) warnings.push(`Pagamento da fatura anterior (${fmt(payments)}) veio desmarcado: a saída já aparece no extrato da conta.`)
  if (nextInstallments.length) {
    warnings.push(
      `Próxima fatura: ${nextInstallments.map((n) => `${n.desc} ${n.n}/${n.of} ${fmt(n.cents)}`).join('; ')}. Elas entram quando você importar a próxima fatura.`,
    )
  }

  const cardLast4s = [...new Set([...cardTotals.keys(), ...readByCard.keys()])]
  return {
    drafts,
    warnings,
    bank: 'Inter',
    closingDate: null,
    statedTotalCents: despesas,
    computedTotalCents: computed,
    cardLast4s,
  }
}
