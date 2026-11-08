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
  return parseMoneyToCents(raw)
}

/**
 * Número digitado ou impresso em formato brasileiro → centavos (com sinal).
 * "1.234,56", "1.500" (milhar), "12,5", "45.90" (decimal com ponto), "R$ -10", "(45,90)" (negativo).
 */
export function parseMoneyToCents(raw: string): number | null {
  let t = raw.trim().replace(/R\$/gi, '').replace(/\s/g, '')
  if (!t) return null
  let neg = false
  if (/^\(.*\)$/.test(t)) {
    neg = true
    t = t.slice(1, -1)
  }
  if (/^[-−]/.test(t) || /[-−]$/.test(t)) {
    neg = true
    t = t.replace(/^[-−]/, '').replace(/[-−]$/, '')
  }
  t = t.replace(/^\+/, '')
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null
  const lastComma = t.lastIndexOf(',')
  const lastDot = t.lastIndexOf('.')
  let normalized: string
  if (lastComma >= 0 && lastDot >= 0) {
    // o separador que vem por último é o decimal
    normalized = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  } else if (lastComma >= 0) {
    normalized = t.replace(/\./g, '').replace(/,(?=.*,)/g, '').replace(',', '.')
  } else if (lastDot >= 0) {
    // "1.500" / "2.000.000" = milhar; "45.9" / "45.90" = decimal
    normalized = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t.replace(/\.(?=.*\.)/g, '')
  } else normalized = t
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  const cents = Math.round(n * 100)
  return neg ? -cents : cents
}

export function parseBrazilianMoneyToCents(s: string): number | null {
  return parseMoneyToCents(s)
}

function validIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "01/10/2026", "1/10/26", "01-10-2026", "2026-10-01" → ISO; datas impossíveis (31/02) → null. */
export function parseBrazilianDate(d: string): string | null {
  const s = d.trim()
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/)
  if (iso) return validIso(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[T\s,].*)?$/)
  if (!m) return null
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  return validIso(y, Number(m[2]), Number(m[1]))
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
