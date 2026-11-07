const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

export function formatBRLFromCents(cents: number): string {
  return BRL.format(cents / 100)
}

/**
 * Valor em CSV: aceita BR (1.234,56 ou 12,34) ou estilo planilha / Nubank (-75.98).
 */
export function parseAmountToCentsForCsv(raw: string): number | null {
  let s = raw.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!s) return null
  const neg = s.startsWith('-') || s.endsWith('-')
  s = s.replace(/^-/, '').replace(/-$/, '')
  if (s.includes(',')) return parseBrazilianMoneyToCents((neg ? '-' : '') + s)
  const dotParts = s.split('.')
  if (dotParts.length === 2) {
    const dec = dotParts[1] ?? ''
    if (dec.length <= 2 && /^\d+$/.test(dec) && /^\d+$/.test(dotParts[0] ?? '')) {
      const n = Number(s)
      if (Number.isNaN(n)) return null
      const cents = Math.round(Math.abs(n) * 100)
      return neg ? -cents : cents
    }
  }
  if (!s.includes('.')) {
    const n = Number(s)
    if (Number.isNaN(n)) return null
    const cents = Math.round(Math.abs(n) * 100)
    return neg ? -cents : cents
  }
  return parseBrazilianMoneyToCents((neg ? '-' : '') + s)
}

export function parseBrazilianMoneyToCents(s: string): number | null {
  let t = s.trim().replace(/\s/g, '').replace(/R\$/g, '')
  if (!t) return null
  const neg = t.startsWith('-') || t.endsWith('-')
  t = t.replace(/^-/, '').replace(/-$/, '')
  const core = t
  const normalized = core.replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  if (Number.isNaN(n)) return null
  const cents = Math.round(n * 100)
  return neg ? -cents : cents
}

export function parseBrazilianDate(d: string): string | null {
  const m = d.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  return `${yyyy}-${mm}-${dd}`
}

const MONTHS: Record<string, string> = {
  JAN: '01',
  FEV: '02',
  MAR: '03',
  ABR: '04',
  MAI: '05',
  JUN: '06',
  JUL: '07',
  AGO: '08',
  SET: '09',
  OUT: '10',
  NOV: '11',
  DEZ: '12',
}

export function parseNubankDayDate(line: string): string | null {
  const m = line.match(/^(\d{2})\s+([A-Z]{3})\s+(\d{4})\b/)
  if (!m) return null
  const mon = MONTHS[m[2]]
  if (!mon) return null
  return `${m[3]}-${mon}-${m[1]}`
}
