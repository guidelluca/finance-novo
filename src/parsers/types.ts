export type ParserId =
  | 'nubank_extrato_v1'
  | 'itau_extrato_v1'
  | 'mercadopago_extrato_v1'
  | 'controle_gastos_pdf_v1'
  | 'csv_brazil_v1'
  | 'csv_finance_pwa_v1'
  | 'csv_nubank_v1'
  | 'csv_nubank_planilha_v1'
  | 'csv_itau_v1'
  | 'csv_mercadopago_v1'
  | 'screenshot_ai_v1'
  | 'screenshot_local_v1'
  | 'fatura_cartao_pdf_v1'

export interface TransactionDraft {
  tempId: string
  date: string
  amountCents: number
  kind: 'debit' | 'credit'
  descriptionRaw: string
  categoryId?: string | null
  /** Texto da coluna Categoria em exports / planilhas — resolvido para id na UI */
  categoryHint?: string | null
  /** Coluna Conta / banco no CSV Finance PWA — sobrescreve o rótulo por ficheiro ao gravar */
  accountHint?: string | null
  /** Ex.: coluna Identificador do CSV Nubank — dedup forte */
  sourceId?: string | null
  /** Cidade impressa na fatura (Itaú) — ajuda a limpar o nome do estabelecimento */
  cityHint?: string | null
  /** Nome legível do estabelecimento (identificado localmente) */
  merchantName?: string | null
  /** Tipo + intermediário, ex.: "Delivery", "via Mercado Pago" */
  merchantDetail?: string | null
  /** Chave para regra aprendida quando o usuário corrigir a categoria */
  merchantRuleKey?: string | null
  /** Categoria sugerida automaticamente (para saber se o usuário corrigiu) */
  autoCategoryId?: string | null
  /** Avisos de revisão (ex.: leitura incerta, possível duplicado) */
  reviewFlags?: string[]
  /** Últimos 4 dígitos do cartão (fatura) — liga ao cartão cadastrado */
  cardLast4?: string | null
  /** Desmarcado na revisão: não será gravado */
  excluded?: boolean
}

export interface ParseResult {
  drafts: TransactionDraft[]
  warnings: string[]
}
