import { looksLikeCreditCardInvoice } from '@/parsers/faturaCartao'
import { looksLikeInterCsv, looksLikeInterPdf } from '@/parsers/inter'
import type { ParserId } from '@/parsers/types'

export function detectParser(filename: string, textHead: string): ParserId | null {
  const lower = filename.toLowerCase()
  const head = textHead.slice(0, 4000)
  // Fatura de cartão antes dos extratos: uma fatura Itaú/Nubank também cita o banco no topo
  if (!lower.endsWith('.csv') && looksLikeCreditCardInvoice(textHead)) {
    return 'fatura_cartao_pdf_v1'
  }
  if (lower.endsWith('.csv') && looksLikeInterCsv(textHead)) return 'csv_inter_v1'
  if (!lower.endsWith('.csv') && looksLikeInterPdf(textHead)) return 'inter_extrato_v1'
  if (
    /controle\s+de\s+gastos/i.test(lower) ||
    (/controle\s+de\s+gastos/i.test(head) && /histórico|historico/i.test(head) && /mês\/ano|mes\/ano/i.test(head))
  ) {
    return 'controle_gastos_pdf_v1'
  }
  if (/^nu[_-]/i.test(filename) || /nubank/i.test(textHead.slice(0, 800))) {
    return 'nubank_extrato_v1'
  }
  if (/itau|itaú/i.test(lower) || /banco itaú/i.test(textHead.slice(0, 2000))) {
    return 'itau_extrato_v1'
  }
  if (
    /mercado\s*pago|mercadopago/.test(lower) ||
    (/extrato de conta/i.test(head) &&
      /id da opera[çc][aã]o/i.test(head) &&
      /detalhe dos movimentos/i.test(head))
  ) {
    return 'mercadopago_extrato_v1'
  }
  if (lower.endsWith('.csv')) {
    return 'csv_brazil_v1'
  }
  return null
}
