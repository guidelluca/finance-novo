// Dados fictícios (parecidos com o uso real) para os prints automáticos de UI.
const U = 'user-demo'
let seq = 0
const id = (p) => `${p}-${++seq}`
const iso = (d) => d.toISOString().slice(0, 10)
const day = (s) => new Date(`${s}T12:00:00Z`)
const add = (s, n) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return iso(d) }

export const categories = [
  'Alimentação', 'Mercado', 'Restaurantes', 'Ifood', 'Uber', 'Transporte', 'Aluguel', 'Contas Mensais',
  'Saúde', 'Lazer', 'Roupas', 'Compras', 'Salário', 'Reserva', 'Pix', 'VR',
].map((name, i) => ({ id: `cat-${i}`, user_id: U, name, parent_id: null, icon: null, color: null, sort_order: i, created_at: '2026-01-01T00:00:00Z' }))
const cat = (n) => categories.find((c) => c.name === n)?.id ?? null

export const import_batches = [
  ['b-itau', 'itau_extrato_v1'], ['b-fat-itau', 'fatura_cartao_pdf_v1'], ['b-fat-picpay', 'fatura_cartao_pdf_v1'],
  ['b-nubank', 'csv_nubank_v1'], ['b-print', 'screenshot_local_v1'],
].map(([i, p]) => ({ id: i, user_id: U, parser_id: p, parser_version: 'v1', status: 'completed', created_at: '2026-11-08T12:00:00Z' }))
export const import_files = import_batches.map((b) => ({ id: `f-${b.id}`, batch_id: b.id, filename: `${b.id}.pdf`, parser_id: b.parser_id, raw_error: null, created_at: b.created_at }))

export const credit_cards = [
  { id: 'card-itau', user_id: U, name: 'Itaú Platinum', last4: '9828', brand: 'visa', limit_cents: 800000, closing_day: 1, due_day: 8, color: null, archived: false, sort_order: 0, created_at: '2026-01-01T00:00:00Z' },
  { id: 'card-picpay', user_id: U, name: 'PicPay', last4: '4421', brand: 'mastercard', limit_cents: 300000, closing_day: 5, due_day: 12, color: null, archived: false, sort_order: 1, created_at: '2026-01-01T00:00:00Z' },
]

export const rules = [
  { id: 'r1', user_id: U, match_type: 'contains', pattern: 'ifood', category_id: cat('Ifood'), priority: 100, enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 'r2', user_id: U, match_type: 'contains', pattern: 'mercadolivre', category_id: cat('VR'), priority: 150, enabled: true, created_at: '2026-01-01T00:00:00Z' },
]

export const savings_goals = [
  { id: 'g1', user_id: U, name: 'Viagem Europa', target_cents: 1500000, sort_order: 0, created_at: '2026-01-01T00:00:00Z' },
  { id: 'g2', user_id: U, name: 'Reserva de emergência', target_cents: 2000000, sort_order: 1, created_at: '2026-01-01T00:00:00Z' },
]
export const savings_entries = [
  ['g1', '2026-08-30', 150000], ['g1', '2026-09-30', 200000], ['g1', '2026-10-30', 180000], ['g2', '2026-09-15', 300000], ['g2', '2026-10-15', 250000],
].map(([g, d, c]) => ({ id: id('se'), user_id: U, goal_id: g, date: d, amount_cents: c, note: null, created_at: `${d}T12:00:00Z` }))

// PRNG determinístico
let s = 42
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (a) => a[Math.floor(rnd() * a.length)]

export const transactions = []
const tx = (date, kind, cents, desc, { account = 'Itaú', category = null, card = null, batch = 'b-itau' } = {}) =>
  transactions.push({
    id: id('t'), user_id: U, date, amount_cents: cents, description_raw: desc, description_normalized: desc.toLowerCase(), kind,
    account, category_id: category ? cat(category) : null, credit_card_id: card, import_batch_id: batch, import_file_id: `f-${batch}`,
    dedup_key: `dk-${seq}`, created_at: `${date}T12:00:00Z`, logical_fingerprint: `lf-${seq}`,
  })

const cardBuys = [
  ['IFD*BLITZ HAMBURGUERIA', 'Ifood', 3289], ['IFD*NAMASTE SALAD', 'Ifood', 2352], ['UBER UBER *TRIP HELP.U', 'Uber', 1890],
  ['99*SAO PAULOBR', 'Uber', 1280], ['SUPERMERCADOS DALBENCAM', 'Mercado', 9072], ['OXXO PEDRO AMERICOSAO P', 'Mercado', 3071],
  ['BJ BURGER LANCHONETECAM', 'Restaurantes', 5300], ['DROGARIA SP', 'Saúde', 5889], ['ZIGFUNTECH', 'Lazer', 4300],
  ['POSTO CID UNIVERSITACAM', null, 3446], ['AMAZON BR', null, 6345],
]
for (let d = '2026-08-28'; d <= '2026-11-08'; d = add(d, 1)) {
  const n = Math.floor(rnd() * 3)
  for (let i = 0; i < n; i++) {
    const [desc, c, base] = pick(cardBuys)
    const itau = rnd() < 0.7
    tx(d, 'debit', Math.round(base * (0.7 + rnd() * 0.6)), desc, {
      account: itau ? 'Cartão Itaú' : 'Cartão PicPay', category: c, card: itau ? 'card-itau' : 'card-picpay', batch: itau ? 'b-fat-itau' : 'b-fat-picpay',
    })
  }
  if (rnd() < 0.35) tx(d, 'debit', pick([540, 1080, 1697]), pick(['PIX QRS VIACAO SANT', 'PIX QRS AUTOPASS S.']), { category: 'Transporte' })
}
for (const [s15, sEnd] of [['2026-09-15', '2026-09-29'], ['2026-10-15', '2026-10-29']]) {
  tx(s15, 'credit', 256000, 'REMUNERACAO/SALARIO', { category: 'Salário' })
  tx(sEnd, 'credit', 273145, 'REMUNERACAO/SALARIO', { category: 'Salário' })
  tx(s15, 'debit', 431635, 'Pagamento de boleto efetuado - LANZA IMOVEIS LTDA', { account: 'Nubank', category: 'Aluguel', batch: 'b-nubank' })
  tx(add(s15, 0), 'debit', 151152, 'PIX TRANSF Guilher · conta própria')
  tx(add(s15, 0), 'credit', 151152, 'Transferência recebida pelo Pix - GUILHERME DE LUCA SANTOS - ITAÚ', { account: 'Nubank', batch: 'b-nubank' })
  tx(add(sEnd, 1), 'debit', 263892, 'FATURA PAGA ITAU PLATINU')
  tx(add(s15, 3), 'debit', 28028, 'Compra no débito via NuPay - VIVO', { account: 'Nubank', category: 'Contas Mensais', batch: 'b-nubank' })
  tx(add(s15, 5), 'debit', 2390, 'Compra no débito via NuPay - EBW*Spotify', { account: 'Nubank', category: 'Contas Mensais', batch: 'b-nubank' })
}
tx('2026-08-28', 'credit', 331395, 'REMUNERACAO/SALARIO', { category: 'Salário' })
tx('2026-11-03', 'debit', 3600, 'MERCADOLIVRE*MERCADOLIV', { account: 'Cartão Itaú', category: 'VR', card: 'card-itau', batch: 'b-fat-itau' })
tx('2026-11-04', 'debit', 4600, 'PIX TRANSF ALLAN D', {})
tx('2026-11-05', 'debit', 1890, 'UBER *TRIP', { account: 'Print', category: 'Uber', batch: 'b-print' })
tx('2026-11-05', 'debit', 1890, 'UBER UBER *TRIP HELP.U', { account: 'Cartão Itaú', category: 'Uber', card: 'card-itau', batch: 'b-fat-itau' })
tx('2026-11-06', 'debit', 300, '99*SAO PAULOBR', { account: 'Cartão Itaú', category: 'Uber', card: 'card-itau', batch: 'b-fat-itau' })
tx('2026-11-06', 'credit', 300, '99*SAO PAULOBR', { account: 'Cartão Itaú', card: 'card-itau', batch: 'b-fat-itau' })

export const user = {
  id: U,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'guilherme@example.com',
  app_metadata: { provider: 'email' },
  user_metadata: {
    owner_name: 'Guilherme de Luca Santos',
    budgets: { total: 450000, byCategory: { [cat('Ifood')]: 40000, [cat('Mercado')]: 80000, [cat('Uber')]: 30000, [cat('Restaurantes')]: 30000 } },
  },
  created_at: '2026-01-01T00:00:00Z',
}

export const tables = { categories, rules, import_batches, import_files, credit_cards, savings_goals, savings_entries, transactions }
