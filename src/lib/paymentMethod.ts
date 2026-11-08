/**
 * Forma de pagamento de um lançamento: Pix, qual cartão de crédito, débito, boleto, TED…
 * Vem do cartão ligado (fatura), do nome da conta e do texto que o banco escreve.
 */
export type PaymentMethod = {
  /** chave estável (para cor e filtro) */
  key: string
  label: string
  group: 'pix' | 'cartao' | 'debito' | 'boleto' | 'transferencia' | 'tarifa' | 'investimento' | 'salario' | 'outro'
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function cardLabel(account: string | null, cardName: string | null): string {
  // o nome da conta da fatura ("Cartão Itaú") manda; o cadastro do cartão só quando a conta é genérica
  const a = (account ?? '').trim()
  if (/^cart[aã]o\b/i.test(a) && !/^cart[aã]o de cr[eé]dito$/i.test(a)) return a
  if (cardName) return /cart[aã]o/i.test(cardName) ? cardName : `Cartão ${cardName}`
  const bank = a.replace(/cart[aã]o|de|cr[eé]dito/gi, '').trim()
  return bank ? `Cartão ${bank}` : 'Cartão de crédito'
}

export function paymentMethodOf(
  t: { description: string; account: string | null; cardId?: string | null; kind?: 'debit' | 'credit' },
  cardNames?: Map<string, string>,
): PaymentMethod {
  const d = fold(t.description)
  const isCard = Boolean(t.cardId) || /^cart[aã]o\b|cr[eé]dito/i.test(t.account ?? '')
  if (isCard && !/fatura paga|pagamento (de |da )?fatura/.test(d)) {
    const label = cardLabel(t.account, t.cardId ? (cardNames?.get(t.cardId) ?? null) : null)
    return { key: `cartao:${fold(label)}`, label, group: 'cartao' }
  }
  if (/fatura paga|pagamento (de |da )?fatura|pagto fatura/.test(d)) return { key: 'fatura', label: 'Pagamento de fatura', group: 'outro' }
  if (/\bpix\b|pelo pix/.test(d)) return { key: 'pix', label: 'Pix', group: 'pix' }
  if (/remunera|salario|folha de pag/.test(d)) return { key: 'salario', label: 'Salário', group: 'salario' }
  if (/boleto|\bpag(to)?\.? bol|cobranca bancaria/.test(d)) return { key: 'boleto', label: 'Boleto', group: 'boleto' }
  if (/^ted\b|^doc\b|^tef\b|transferencia (enviada|recebida)?(?! pelo pix)/.test(d)) return { key: 'ted', label: 'TED / transferência', group: 'transferencia' }
  if (/juros|\biof\b|tarifa|anuidade|encargo|multa/.test(d)) return { key: 'tarifa', label: 'Tarifas e juros', group: 'tarifa' }
  if (/rend(imento)?s?\b|aplic|resgate|\brdb\b|\bcdb\b|investimento|poupanca/.test(d)) return { key: 'invest', label: 'Investimentos', group: 'investimento' }
  if (/debito|nupay|compra no deb|cartao deb|elo deb|maestro|visa electron|^pay\b|^compra\b/.test(d)) return { key: 'debito', label: 'Débito', group: 'debito' }
  return { key: 'outro', label: 'Outros', group: 'outro' }
}
