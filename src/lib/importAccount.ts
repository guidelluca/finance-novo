import type { ParserId } from '@/parsers/types'

/** Rótulo mostrado em análises; preenchido no import conforme parser e ficheiro. */
export function accountLabelFromImport(parserId: ParserId, filename: string): string {
  const lower = filename.toLowerCase()
  if (
    parserId === 'nubank_extrato_v1' ||
    parserId === 'csv_nubank_v1' ||
    parserId === 'csv_nubank_planilha_v1' ||
    /^nu[_-]/i.test(filename)
  ) {
    return 'Nubank'
  }
  if (parserId === 'controle_gastos_pdf_v1' || /controle\s+de\s+gastos/i.test(lower)) {
    return 'Controle de gastos (PDF)'
  }
  if (parserId === 'itau_extrato_v1' || parserId === 'csv_itau_v1' || /itau|itaú/.test(lower)) {
    return 'Itaú'
  }
  if (
    parserId === 'mercadopago_extrato_v1' ||
    parserId === 'csv_mercadopago_v1' ||
    /mercado\s*pago|mercadopago|mp[_-]/i.test(lower)
  ) {
    return 'Mercado Pago'
  }
  if (parserId === 'csv_finance_pwa_v1') {
    return 'Finance PWA (CSV)'
  }
  if (parserId === 'csv_brazil_v1') {
    return 'CSV (genérico)'
  }
  if (parserId === 'screenshot_ai_v1') {
    return 'Print (IA)'
  }
  if (parserId === 'screenshot_local_v1') {
    return 'Print'
  }
  if (parserId === 'fatura_cartao_pdf_v1') {
    return 'Cartão de crédito'
  }
  return 'Outro'
}
