/**
 * Crédito lançado NO CARTÃO que é pagamento da fatura (não é estorno nem renda):
 * "PAGAMENTO RECEBIDO", "PAGAMENTO DE FATURA", "PAGAMENTO COM SALDO", "PAGAMENTO ON LINE", "PGTO"...
 */
const CARD_SIDE = /pagamento|pgto|pagto|\bpag\b|fatura paga/i
const NOT_PAYMENT = /estorno|devolu|cancel|reembolso|cashback|ajuste a cr[eé]dito|cr[eé]dito de|desconto/i

export function isCardPaymentCredit(description: string, ofCategory?: string | null): boolean {
  if (ofCategory && /credit card payment/i.test(ofCategory)) return true
  return CARD_SIDE.test(description) && !NOT_PAYMENT.test(description)
}
