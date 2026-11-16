/**
 * Categorias que a Pluggy (Meu Pluggy / Open Finance) já dá para cada transação.
 * Ela classifica pelo estabelecimento real (CNPJ/MCC), então ajuda muito quando o texto é ruim
 * ("MarcioRamalhoDaSAO PAULOBR", "NilsonLima"). Aqui viram nomes de categoria do app, em ordem de preferência.
 * Categorias genéricas demais ("Shopping", "Services", "Transfers") não decidem nada.
 */
type Entry = { label: string; categories: readonly string[] }

const FOOD = 'Alimentação'
const M: Record<string, Entry> = {
  // comida
  'food delivery': { label: 'Delivery', categories: ['Ifood', 'iFood', 'Delivery', 'Restaurantes', FOOD] },
  'eating out': { label: 'Restaurante', categories: ['Restaurantes', 'Restaurante', FOOD] },
  groceries: { label: 'Mercado', categories: ['Mercado', 'Supermercado', FOOD] },
  'food and drinks': { label: 'Alimentação', categories: [FOOD] },
  // transporte
  'taxi and ride-hailing': { label: 'Uber / 99', categories: ['Uber', 'Transporte'] },
  'public transportation': { label: 'Transporte público', categories: ['Transporte', 'Ônibus', 'Transporte público'] },
  'bus tickets': { label: 'Ônibus', categories: ['Transporte', 'Ônibus', 'Transporte público'] },
  transportation: { label: 'Transporte', categories: ['Transporte'] },
  'gas stations': { label: 'Combustível', categories: ['Combustível', 'Carro', 'Transporte'] },
  parking: { label: 'Estacionamento', categories: ['Estacionamento', 'Carro', 'Transporte'] },
  'tolls and in vehicle payment': { label: 'Pedágio', categories: ['Estacionamento', 'Carro', 'Transporte'] },
  'car rental': { label: 'Aluguel de carro', categories: ['Viagem', 'Transporte'] },
  'vehicle maintenance': { label: 'Manutenção do carro', categories: ['Carro', 'Transporte'] },
  automotive: { label: 'Carro', categories: ['Carro', 'Transporte'] },
  // saúde / cuidado
  pharmacy: { label: 'Farmácia', categories: ['Auto cuidado', 'Autocuidado', 'Saúde', 'Farmácia'] },
  healthcare: { label: 'Saúde', categories: ['Saúde'] },
  dentist: { label: 'Dentista', categories: ['Saúde'] },
  'hospital clinics and labs': { label: 'Clínica / exame', categories: ['Saúde'] },
  optometry: { label: 'Ótica', categories: ['Saúde'] },
  'gyms and fitness centers': { label: 'Academia', categories: ['Academia', 'Saúde'] },
  'wellness and fitness': { label: 'Bem-estar', categories: ['Academia', 'Auto cuidado', 'Saúde'] },
  wellness: { label: 'Bem-estar', categories: ['Auto cuidado', 'Autocuidado', 'Saúde'] },
  'sports practice': { label: 'Esporte', categories: ['Academia', 'Lazer'] },
  // compras
  clothing: { label: 'Roupas', categories: ['Roupas', 'Vestuário', 'Compras'] },
  'online shopping': { label: 'Compra online', categories: ['Compras', 'Compras online'] },
  electronics: { label: 'Eletrônicos', categories: ['Compras', 'Eletrônicos'] },
  houseware: { label: 'Casa', categories: ['Casa', 'Compras'] },
  'pet supplies and vet': { label: 'Pet', categories: ['Pet', 'Pets'] },
  'sports goods': { label: 'Artigos esportivos', categories: ['Compras'] },
  bookstore: { label: 'Livraria', categories: ['Educação', 'Compras'] },
  'kids and toys': { label: 'Brinquedos', categories: ['Compras'] },
  // digital / contas
  'digital services': { label: 'Serviço digital', categories: ['Assinaturas', 'Contas Mensais'] },
  'video streaming': { label: 'Streaming', categories: ['Assinaturas', 'Contas Mensais'] },
  'music streaming': { label: 'Streaming', categories: ['Assinaturas', 'Contas Mensais'] },
  gaming: { label: 'Jogos', categories: ['Lazer'] },
  telecommunications: { label: 'Celular / internet', categories: ['Contas Mensais', 'Contas'] },
  internet: { label: 'Internet', categories: ['Contas Mensais', 'Contas'] },
  mobile: { label: 'Celular', categories: ['Contas Mensais', 'Contas'] },
  tv: { label: 'TV', categories: ['Contas Mensais', 'Contas'] },
  utilities: { label: 'Contas da casa', categories: ['Contas Mensais', 'Contas'] },
  water: { label: 'Água', categories: ['Contas Mensais', 'Contas'] },
  electricity: { label: 'Energia', categories: ['Contas Mensais', 'Contas'] },
  // lazer / viagem
  travel: { label: 'Viagem', categories: ['Viagem', 'Lazer'] },
  'airport and airlines': { label: 'Passagem aérea', categories: ['Viagem', 'Lazer'] },
  accomodation: { label: 'Hospedagem', categories: ['Viagem', 'Lazer'] },
  accommodation: { label: 'Hospedagem', categories: ['Viagem', 'Lazer'] },
  leisure: { label: 'Lazer', categories: ['Lazer'] },
  tickets: { label: 'Ingressos', categories: ['Lazer'] },
  'cinema theater and concerts': { label: 'Show / cinema', categories: ['Lazer'] },
  'stadiums and arenas': { label: 'Evento', categories: ['Lazer'] },
  'landmarks and museums': { label: 'Passeio', categories: ['Lazer', 'Viagem'] },
  // educação
  education: { label: 'Educação', categories: ['Educação', 'Estudos'] },
  'online courses': { label: 'Curso', categories: ['Educação', 'Estudos'] },
  university: { label: 'Faculdade', categories: ['Educação', 'Estudos'] },
  // dinheiro
  salary: { label: 'Salário', categories: ['Salário', 'Renda', 'Receitas'] },
  'proceeds interests and dividends': { label: 'Rendimento', categories: ['Rendimentos', 'Investimentos'] },
  'interests charged': { label: 'Juros', categories: ['Taxas', 'Tarifas', 'Impostos'] },
  'tax on financial operations': { label: 'IOF', categories: ['Taxas', 'Impostos', 'Tarifas'] },
  taxes: { label: 'Impostos', categories: ['Impostos', 'Taxas'] },
  'bank fees': { label: 'Tarifa', categories: ['Tarifas', 'Taxas'] },
  'account fees': { label: 'Tarifa', categories: ['Tarifas', 'Taxas'] },
  'credit card fees': { label: 'Tarifa do cartão', categories: ['Tarifas', 'Taxas'] },
  'loans and financing': { label: 'Empréstimo', categories: ['Empréstimos', 'Dívidas'] },
  loans: { label: 'Empréstimo', categories: ['Empréstimos', 'Dívidas'] },
  donations: { label: 'Doação', categories: ['Doações', 'Assinaturas'] },
  insurance: { label: 'Seguro', categories: ['Seguros', 'Contas Mensais'] },
  'health insurance': { label: 'Plano de saúde', categories: ['Saúde', 'Seguros'] },
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()

/** Rótulo em português (ou null se a categoria da Pluggy for genérica/desconhecida). */
export function pluggyLabel(cat: string | null | undefined): string | null {
  return cat ? (M[norm(cat)]?.label ?? null) : null
}

/** Categoria do app equivalente à da Pluggy (null se genérica ou se você não tem nenhuma parecida). */
export function pluggyCategoryId(cat: string | null | undefined, categories: { id: string; name: string }[]): string | null {
  const e = cat ? M[norm(cat)] : undefined
  if (!e) return null
  for (const name of e.categories) {
    const hit = categories.find((c) => norm(c.name) === norm(name))
    if (hit) return hit.id
  }
  return null
}
