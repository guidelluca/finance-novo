import { parseAmountToCentsForCsv, parseBrazilianDate } from '@/lib/currency'
import Papa from 'papaparse'
import type { ParseResult } from '@/parsers/types'

export type CsvProfileId =
  | 'generic_br'
  | 'finance_pwa_csv'
  | 'nubank_csv'
  | 'nubank_planilha_tsv'
  | 'itau_csv'
  | 'mercadopago_csv'

export interface CsvProfile {
  id: CsvProfileId
  label: string
  delimiter: string
  dateColumn: string
  descriptionColumn: string
  amountColumn: string
  dateAlternates?: readonly string[]
  descriptionAlternates?: readonly string[]
  amountAlternates?: readonly string[]
  kindColumn?: string
  creditValue?: string
  sourceIdColumn?: string
  /** Colunas tipo "Entrada / Saída": deriva kind pelo texto da célula */
  entradaSaidaColumns?: readonly string[]
  /** Coluna com categoria já classificada no export (texto livre) */
  categoryColumn?: string
  categoryAlternates?: readonly string[]
  /** Conta / cartão por linha (CSV exportado pelo app ou planilha própria) */
  accountColumn?: string
  accountAlternates?: readonly string[]
}

export const CSV_PROFILES: CsvProfile[] = [
  /**
   * Formato recomendado para exportar / importar no próprio app:
   * UTF-8, vírgula ou ponto e vírgula (detetado pela primeira linha).
   * Cabeçalhos: data, descricao, valor, tipo, categoria (opcional), conta (opcional)
   */
  {
    id: 'finance_pwa_csv',
    label: 'Finance PWA — CSV (transações + categorias)',
    delimiter: ',',
    dateColumn: 'data',
    descriptionColumn: 'descricao',
    amountColumn: 'valor',
    dateAlternates: ['date'],
    descriptionAlternates: ['descrição', 'historico', 'histórico', 'memo', 'detalhe'],
    amountAlternates: ['valor_rs', 'valor_r$'],
    kindColumn: 'tipo',
    creditValue: 'C',
    categoryColumn: 'categoria',
    categoryAlternates: ['categoria_nome', 'category'],
    accountColumn: 'conta',
    accountAlternates: ['account', 'cartao', 'cartão', 'banco'],
  },
  {
    id: 'generic_br',
    label: 'Genérico BR (data;descrição;valor)',
    delimiter: ';',
    dateColumn: 'data',
    descriptionColumn: 'descricao',
    amountColumn: 'valor',
    kindColumn: 'tipo',
    creditValue: 'C',
  },
  {
    id: 'nubank_csv',
    label: 'Nubank — CSV (Data, Valor, Descrição)',
    delimiter: ',',
    dateColumn: 'data',
    descriptionColumn: 'descricao',
    amountColumn: 'valor',
    sourceIdColumn: 'identificador',
  },
  /** Export / cópia de planilha: abas, colunas Data, Histórico, Descrição, Entrada/Saída, Valor, Categoria */
  {
    id: 'nubank_planilha_tsv',
    label: 'Nubank — planilha (TSV / copiar-colar)',
    delimiter: '\t',
    dateColumn: 'data',
    descriptionColumn: 'descrição',
    amountColumn: 'valor',
    descriptionAlternates: ['descricao', 'historico', 'histórico'],
    entradaSaidaColumns: ['entrada / saída', 'entrada/saida', 'entrada / saida'],
    categoryColumn: 'categoria',
  },
  /** Itaú: extrato em CSV costuma usar `;`, colunas Data / Lançamento ou Histórico / Valor (R$) */
  {
    id: 'itau_csv',
    label: 'Itaú — CSV',
    delimiter: ';',
    dateColumn: 'data',
    descriptionColumn: 'lancamento',
    amountColumn: 'valor',
    dateAlternates: ['data_movimento', 'data_do_lancamento', 'date'],
    descriptionAlternates: ['historico', 'descricao', 'detalhe', 'historico_do_lancamento', 'memo'],
    amountAlternates: ['Valor (R$)', 'valor_(r$)', 'valor_r$', 'valor_rs'],
  },
  /** Mercado Pago: muitas vezes `,` e cabeçalhos em PT ou EN */
  {
    id: 'mercadopago_csv',
    label: 'Mercado Pago — CSV',
    delimiter: ',',
    dateColumn: 'data',
    descriptionColumn: 'descricao',
    amountColumn: 'valor',
    dateAlternates: [
      'data_de_lancamento',
      'data_da_transacao',
      'data_movimento',
      'date',
      'fecha',
      'data da transação',
    ],
    descriptionAlternates: [
      'description',
      'detalhe',
      'titulo',
      'title',
      'descricao_do_movimento',
      'producto',
      'produto',
    ],
    amountAlternates: ['amount', 'montante', 'total', 'valor_da_transacao', 'importe'],
  },
]

let idSeq = 0
function nextId() {
  idSeq += 1
  return `csv-${idSeq}`
}

function normKey(s: string) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function rowMap(headers: string[], row: string[]) {
  const m = new Map<string, string>()
  headers.forEach((h, i) => {
    const key = normKey(h.replace(/^\ufeff/, ''))
    m.set(key, (row[i] ?? '').trim())
  })
  return m
}

function sniffDelimiter(headerLine: string): ',' | ';' {
  const line = headerLine.replace(/^\ufeff/, '')
  const commas = (line.match(/,/g) ?? []).length
  const semis = (line.match(/;/g) ?? []).length
  return semis > commas ? ';' : ','
}

/** Valores de `tipo` no CSV Finance PWA (PT/EN, com ou sem acentos). */
function kindFromFinancePwaTipo(raw: string): 'debit' | 'credit' | null {
  const t = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (!t) return null
  if (/^(c|credito|entrada|\+|receita|credit|income)$/.test(t)) return 'credit'
  if (/^(d|debito|saida|despesa|debit|expense|-)$/.test(t)) return 'debit'
  return null
}

export function parseFinancePwaCsv(content: string): ParseResult {
  const text = content.replace(/^\ufeff/, '')
  const firstLineEnd = text.search(/\r?\n/)
  const headerLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)
  const delimiter = sniffDelimiter(headerLine)
  const profile = CSV_PROFILES.find((p) => p.id === 'finance_pwa_csv')
  if (!profile) return { drafts: [], warnings: ['Perfil finance_pwa_csv não encontrado.'] }
  return parseCsvBrazil(text, { ...profile, delimiter })
}

function kindFromEntradaSaida(
  r: Map<string, string>,
  cols: readonly string[] | undefined,
): 'debit' | 'credit' | null {
  if (!cols?.length) return null
  const raw = cell(r, ...cols)
  if (!raw) return null
  const n = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (n.includes('entrada')) return 'credit'
  if (n.includes('saida')) return 'debit'
  return null
}

/** Primeira coluna não vazia entre candidatos (cabeçalho literal → normalizado). */
function cell(r: Map<string, string>, ...candidates: string[]): string {
  for (const c of candidates) {
    if (!c) continue
    const v = r.get(normKey(c))
    if (v != null && v !== '') return v
  }
  return ''
}

export function parseCsvBrazil(content: string, profile: CsvProfile): ParseResult {
  idSeq = 0
  const warnings: string[] = []
  const parsed = Papa.parse<string[]>(content, {
    delimiter: profile.delimiter,
    skipEmptyLines: true,
  })
  if (parsed.errors.length) {
    warnings.push(...parsed.errors.map((e) => e.message))
  }
  const rows = parsed.data
  if (rows.length < 2) {
    return { drafts: [], warnings: [...warnings, 'CSV vazio ou sem cabeçalho.'] }
  }
  const headerList = rows[0].map((h) => h.replace(/^\ufeff/, ''))
  const drafts: ParseResult['drafts'] = []

  const dateCands = [
    profile.dateColumn,
    ...(profile.dateAlternates ?? []),
    'data',
    'date',
  ]
  const descCands = [
    profile.descriptionColumn,
    ...(profile.descriptionAlternates ?? []),
    'descricao',
    'historico',
    'lancamento',
  ]
  const amtCands = [
    profile.amountColumn,
    ...(profile.amountAlternates ?? []),
    'valor',
  ]

  for (let i = 1; i < rows.length; i++) {
    const r = rowMap(headerList, rows[i])
    const dRaw = cell(r, ...dateCands)
    const desc = cell(r, ...descCands)
    const amtRaw = cell(r, ...amtCands)

    if (!dRaw && !amtRaw) continue

    const iso = parseBrazilianDate(dRaw) ?? dRaw.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
    if (!iso) {
      warnings.push(`Linha ${i + 1}: data inválida "${dRaw}"`)
      continue
    }

    const cents = parseAmountToCentsForCsv(amtRaw.replace(/^R\$\s*/i, ''))
    if (cents == null) {
      if (dRaw || desc) {
        warnings.push(`Linha ${i + 1}: valor vazio ou inválido "${amtRaw}" — ignorada`)
      }
      continue
    }

    const fromFlow = kindFromEntradaSaida(r, profile.entradaSaidaColumns)
    let kind: 'debit' | 'credit' =
      fromFlow ?? (cents < 0 ? 'debit' : 'credit')
    if (profile.kindColumn) {
      const t =
        r.get(normKey(profile.kindColumn)) ??
        r.get(normKey('tipo')) ??
        ''
      if (profile.id === 'finance_pwa_csv') {
        const fk = kindFromFinancePwaTipo(t)
        if (fk) kind = fk
        else if (profile.creditValue && t.toUpperCase() === profile.creditValue.toUpperCase()) {
          kind = 'credit'
        } else if (t.trim()) {
          warnings.push(
            `Linha ${i + 1}: tipo "${t}" não reconhecido — usado o sinal do valor (negativo = débito).`,
          )
        }
      } else if (profile.creditValue && t.toUpperCase() === profile.creditValue.toUpperCase()) {
        kind = 'credit'
      } else if (t) kind = 'debit'
    }

    const amountCents = Math.abs(cents)
    const descriptionRaw = (desc || 'Lançamento importado').slice(0, 500)
    let sourceId: string | null = null
    if (profile.sourceIdColumn) {
      const sid = r.get(normKey(profile.sourceIdColumn)) ?? ''
      if (sid) sourceId = sid.slice(0, 256)
    }

    let categoryHint: string | null = null
    if (profile.categoryColumn) {
      const ch = cell(r, profile.categoryColumn, ...(profile.categoryAlternates ?? []))
      if (ch) categoryHint = ch.slice(0, 120)
    }

    let accountHint: string | null = null
    if (profile.accountColumn) {
      const acc = cell(r, profile.accountColumn, ...(profile.accountAlternates ?? []))
      if (acc) accountHint = acc.slice(0, 120)
    }

    drafts.push({
      tempId: nextId(),
      date: iso.slice(0, 10),
      amountCents,
      kind,
      descriptionRaw,
      categoryHint,
      accountHint,
      sourceId,
    })
  }

  return { drafts, warnings }
}
