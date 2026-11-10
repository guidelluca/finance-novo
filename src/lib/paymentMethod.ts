/**
 * Forma de pagamento de cada lançamento: Pix, crédito (e qual cartão), débito, boleto, transferência…
 * Vem da conta (fatura de cartão) e do texto do lançamento no extrato.
 */
export type MethodGroup =
  | 'pix'
  | 'vr'
  | 'credito'
  | 'debito'
  | 'boleto'
  | 'transferencia'
  | 'salario'
  | 'investimento'
  | 'tarifa'
  | 'pagamento_fatura'
  | 'outro'

export type PaymentMethod = {
  group: MethodGroup
  /** chave estável para agrupar (um cartão = uma chave) */
  key: string
  /** curto, para a lista: "Pix", "Crédito · Cartão Itaú", "Débito" */
  label: string
}

export type CardInfo = { id: string; name: string; last4: string | null }

const CARD_ACCOUNT = /^cart[aã]o\b|cr[eé]dito/i

export const GROUP_LABEL: Record<MethodGroup, string> = {
  pix: 'Pix',
  vr: 'VR (Alelo)',
  credito: 'Crédito',
  debito: 'Débito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  salario: 'Salário',
  investimento: 'Aplicação / resgate',
  tarifa: 'Tarifas e juros',
  pagamento_fatura: 'Pagamento de fatura',
  outro: 'Outros',
}

function cardLabel(account: string | null, card: CardInfo | undefined): string {
  // a conta da fatura ("Cartão Itaú") manda: o mesmo cartão fica junto, ligado ou não ao cadastro
  const base = account && CARD_ACCOUNT.test(account) ? account : card?.name?.trim() || 'Cartão de crédito'
  return /^cart[aã]o/i.test(base) ? base : `Cartão ${base}`
}

export function paymentMethodOf(
  t: { description: string; account: string | null; cardId?: string | null },
  cards?: Map<string, CardInfo>,
): PaymentMethod {
  const d = t.description
  // vale-refeição: tudo que veio do extrato do Alelo (compras e o crédito do benefício)
  if (/alelo|\bvr\b|vale.?refei/i.test(t.account ?? '')) return { group: 'vr', key: 'vr', label: GROUP_LABEL.vr }
  // compra no cartão de crédito: veio de fatura (ligada a um cartão ou conta "Cartão …")
  if (t.cardId || CARD_ACCOUNT.test(t.account ?? '')) {
    const card = t.cardId ? cards?.get(t.cardId) : undefined
    if (/^iof\b/i.test(d)) return { group: 'tarifa', key: 'tarifa', label: `Tarifas e juros · ${cardLabel(t.account, card)}` }
    const label = cardLabel(t.account, card)
    return { group: 'credito', key: `credito:${label.toLowerCase()}`, label: `Crédito · ${label}` }
  }
  const make = (group: MethodGroup): PaymentMethod => ({ group, key: group, label: GROUP_LABEL[group] })
  if (/fatura paga|pagamento (de |da )?fatura|pagto\.? fatura/i.test(d)) return make('pagamento_fatura')
  if (/remunera[cç][aã]o|sal[aá]rio|folha de pag/i.test(d)) return make('salario')
  if (/\bpix\b/i.test(d)) return make('pix')
  if (/boleto|pag(to)?\.? cobran[cç]a|pagamento de t[ií]tulo|\bdda\b/i.test(d)) return make('boleto')
  if (/d[eé]bito|nupay|compra (no )?cart[aã]o|^pay\b|^compra\b/i.test(d)) return make('debito')
  if (/^(ted|doc|tef)\b|transfer[eê]ncia/i.test(d)) return make('transferencia')
  if (/\brdb\b|\bcdb\b|aplica[cç][aã]o|resgate|rend(imento)?s?\.? pago|invest/i.test(d)) return make('investimento')
  if (/^iof\b|juros|tarifa|anuidade|encargo/i.test(d)) return make('tarifa')
  return make('outro')
}
