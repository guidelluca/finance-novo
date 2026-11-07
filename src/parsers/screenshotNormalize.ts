/**
 * Validação e normalização da resposta da IA ao ler prints bancários.
 * Sem dependências (testável isoladamente). A IA erra: aqui nada é aceito sem checagem.
 */

export type AiScreenshotRow = {
  date?: string | null
  description?: string | null
  amount?: number | string | null
  direction?: 'in' | 'out' | string | null
  status?: 'posted' | 'pending' | string | null
  date_inferred?: boolean | null
  confidence?: number | null
  installment?: string | null
  /** Índice (1-based) do print onde a linha aparece */
  print?: number | null
}

export type AiScreenshotResponse = {
  bank?: string | null
  screen_type?: string | null
  rows?: AiScreenshotRow[] | null
  warnings?: string[] | null
}

export type NormalizedScreenshotRow = {
  date: string
  amountCents: number
  kind: 'debit' | 'credit'
  descriptionRaw: string
  flags: string[]
  /** Sugestão: deixar fora da importação por padrão (pendente, data incerta…) */
  excludeByDefault: boolean
}

export type NormalizeResult = {
  rows: NormalizedScreenshotRow[]
  warnings: string[]
  droppedCount: number
}

/** Linhas que nunca são transações, mesmo que a IA as devolva. */
const NOT_A_TRANSACTION =
  /^(saldo|saldo (do dia|dispon[ií]vel|atual|em conta|anterior|final)|limite( dispon[ií]vel)?|total( de)? (entradas|sa[ií]das|da fatura|gasto)|fatura (atual|fechada|aberta)|valor da fatura|rendimento do (m[eê]s|per[ií]odo)|pagamento m[ií]nimo)\b/i

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Aceita 1234.56, "1.234,56", "R$ 1.234,56", "-45,90", "45.9". Devolve centavos positivos. */
export function amountToCents(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    return Math.round(Math.abs(raw) * 100)
  }
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/R\$/gi, '').replace(/\s/g, '').replace(/^[+-]|[+-]$/g, '')
  if (!s) return null
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '')
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.abs(n) * 100)
}

function normalizeDescription(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function dupKey(r: { date: string; amountCents: number; kind: string; descriptionRaw: string }): string {
  return `${r.date}|${r.amountCents}|${r.kind}|${r.descriptionRaw.toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

/**
 * @param today ISO (YYYY-MM-DD) no fuso do utilizador
 */
export function normalizeScreenshotResponse(raw: AiScreenshotResponse, today: string): NormalizeResult {
  const warnings: string[] = []
  const out: NormalizedScreenshotRow[] = []
  /** chave → prints onde já apareceu (só descarta repetição entre prints diferentes) */
  const seen = new Map<string, Set<number>>()
  let dropped = 0
  const rows = Array.isArray(raw?.rows) ? raw.rows : []

  for (const r of rows) {
    const flags: string[] = []
    let excludeByDefault = false

    const desc = normalizeDescription(String(r?.description ?? ''))
    if (!desc || NOT_A_TRANSACTION.test(desc)) {
      dropped++
      continue
    }

    const cents = amountToCents(r?.amount)
    if (cents == null || cents === 0) {
      dropped++
      continue
    }
    if (cents > 100_000_000) {
      // > R$ 1 milhão num print pessoal: quase certamente leitura errada
      flags.push('valor muito alto — confira')
      excludeByDefault = true
    }

    const dir = String(r?.direction ?? '').toLowerCase()
    let kind: 'debit' | 'credit'
    if (dir === 'in' || dir === 'credit' || dir === 'entrada') kind = 'credit'
    else if (dir === 'out' || dir === 'debit' || dir === 'saida' || dir === 'saída') kind = 'debit'
    else {
      kind = /recebid|estorno|reembolso|sal[aá]rio|dep[oó]sito|resgate|cashback/i.test(desc) ? 'credit' : 'debit'
      flags.push('entrada/saída deduzida')
    }

    let date = typeof r?.date === 'string' ? r.date.trim() : ''
    if (!isIsoDate(date)) {
      date = today
      flags.push('sem data — usei hoje')
      excludeByDefault = true
    } else if (date > addDays(today, 1)) {
      // Ano provavelmente errado (ex.: "12 DEZ" lido como do ano corrente em janeiro)
      const prevYear = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`
      if (isIsoDate(prevYear) && prevYear <= today) {
        date = prevYear
        flags.push('ano ajustado')
      } else {
        flags.push('data no futuro — confira')
      }
    }
    if (r?.date_inferred) flags.push('data deduzida')

    if (String(r?.status ?? '').toLowerCase() === 'pending') {
      flags.push('pendente/agendada')
      excludeByDefault = true
    }

    const conf = typeof r?.confidence === 'number' ? r.confidence : null
    if (conf != null && conf < 0.7) flags.push('leitura incerta')

    const installment = r?.installment?.trim()
    const descriptionRaw =
      installment && !desc.toLowerCase().includes(installment.toLowerCase()) ? `${desc} (${installment})` : desc

    const row = { date, amountCents: cents, kind, descriptionRaw, flags, excludeByDefault }
    const k = dupKey(row)
    const printIdx = typeof r?.print === 'number' ? r.print : -1
    const prints = seen.get(k)
    if (prints) {
      const fromOtherPrint = printIdx === -1 || [...prints].some((p) => p !== printIdx)
      if (fromOtherPrint) {
        // mesma transação visível em dois prints sobrepostos
        dropped++
        continue
      }
      row.flags.push('repetida no mesmo print — confira')
    }
    if (!prints) seen.set(k, new Set([printIdx]))
    else prints.add(printIdx)
    out.push(row)
  }

  for (const w of raw?.warnings ?? []) {
    if (typeof w === 'string' && w.trim()) warnings.push(w.trim())
  }
  if (rows.length === 0) {
    warnings.push('Nenhuma transação encontrada nos prints. Confira se o print mostra a lista de lançamentos.')
  } else if (dropped > 0) {
    warnings.push(`${dropped} linha(s) descartada(s): repetidas entre prints, saldos/totais ou sem valor.`)
  }

  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { rows: out, warnings, droppedCount: dropped }
}
