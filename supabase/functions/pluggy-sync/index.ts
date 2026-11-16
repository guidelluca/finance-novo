// Open Finance via Meu Pluggy (uso pessoal, só leitura).
// Segredos (Supabase → Edge Functions → Secrets):
//   PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET  → do dashboard da Pluggy (nunca no app nem no GitHub)
//   ALLOWED_USER_ID                         → o seu id de usuário do app (mostrado na tela Open Finance)
// Ações (POST JSON): { action: 'status' | 'refresh' | 'transactions' | 'cards' | 'overview', itemIds: string[], from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://guidelluca.github.io', 'http://localhost:5173', 'http://localhost:4173']
const API = 'https://api.pluggy.ai'

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

type Body = { action?: string; itemIds?: string[]; from?: string; to?: string }

async function pluggyKey(): Promise<string> {
  const clientId = Deno.env.get('PLUGGY_CLIENT_ID')
  const clientSecret = Deno.env.get('PLUGGY_CLIENT_SECRET')
  if (!clientId || !clientSecret) throw new Error('Faltam os segredos PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET na função.')
  const r = await fetch(`${API}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.apiKey) throw new Error(`Pluggy recusou as credenciais (${r.status}).`)
  return j.apiKey as string
}

async function pget(key: string, path: string) {
  const r = await fetch(`${API}${path}`, { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Pluggy ${path.split('?')[0]}: ${j.message ?? r.status}`)
  return j
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get('origin')), 'Content-Type': 'application/json' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const fail = (status: number, message: string) => new Response(JSON.stringify({ ok: false, message }), { status, headers })
  try {
    // só o dono do app: confere o login do Supabase e o id permitido
    const auth = req.headers.get('Authorization') ?? ''
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
    const { data: u } = await sb.auth.getUser()
    const allowed = Deno.env.get('ALLOWED_USER_ID')
    if (!u?.user) return fail(401, 'Entre no app para usar o Open Finance.')
    if (!allowed) return fail(403, 'Falta o segredo ALLOWED_USER_ID na função.')
    if (u.user.id !== allowed) return fail(403, 'Este usuário não tem permissão para o Open Finance.')

    const body = (await req.json().catch(() => ({}))) as Body
    const itemIds = (body.itemIds ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10)
    if (!itemIds.length) return fail(400, 'Nenhum itemId válido.')
    const key = await pluggyKey()

    if (body.action === 'refresh') {
      const out = []
      for (const id of itemIds) {
        const r = await fetch(`${API}/items/${id}`, { method: 'PATCH', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: '{}' })
        const j = await r.json().catch(() => ({}))
        out.push({ id, ok: r.ok, status: j.status ?? null, message: r.ok ? null : (j.message ?? String(r.status)) })
      }
      return new Response(JSON.stringify({ ok: true, items: out }), { headers })
    }

    if (body.action === 'status') {
      const out = []
      for (const id of itemIds) {
        try {
          const it = await pget(key, `/items/${id}`)
          const acc = await pget(key, `/accounts?itemId=${id}`)
          out.push({
            id,
            status: it.status,
            executionStatus: it.executionStatus ?? null,
            connector: it.connector?.name ?? null,
            lastUpdatedAt: it.lastUpdatedAt ?? null,
            accounts: (acc.results ?? []).map((a: Record<string, unknown>) => ({
              id: a.id,
              type: a.type,
              subtype: a.subtype,
              name: a.marketingName ?? a.name,
              number: a.number,
              balance: a.balance,
            })),
          })
        } catch (e) {
          out.push({ id, error: (e as Error).message })
        }
      }
      return new Response(JSON.stringify({ ok: true, items: out }), { headers })
    }

    if (body.action === 'overview') {
      // saldos das contas, investimentos e empréstimos (para patrimônio, dívidas e conferência de saldo)
      const accounts = []
      const investments = []
      const loans = []
      const errors: string[] = []
      for (const id of itemIds) {
        try {
          const acc = await pget(key, `/accounts?itemId=${id}`)
          for (const a of acc.results ?? []) {
            accounts.push({
              itemId: id,
              id: a.id,
              type: a.type,
              subtype: a.subtype,
              name: a.marketingName ?? a.name,
              number: a.number,
              balanceCents: Math.round(Number(a.balance ?? 0) * 100),
              overdraftLimitCents:
                a.bankData?.overdraftContractedLimit != null ? Math.round(Number(a.bankData.overdraftContractedLimit) * 100) : null,
            })
          }
        } catch (e) {
          errors.push(`contas ${id}: ${(e as Error).message}`)
        }
        try {
          const inv = await pget(key, `/investments?itemId=${id}&pageSize=200`)
          for (const v of inv.results ?? []) {
            if (v.status && v.status !== 'ACTIVE') continue
            investments.push({
              itemId: id,
              id: v.id,
              name: v.name,
              type: v.type,
              subtype: v.subtype ?? null,
              balanceCents: Math.round(Number(v.balance ?? v.amount ?? 0) * 100),
              lastMonthRate: v.lastMonthRate ?? null,
              annualRate: v.annualRate ?? null,
              dueDate: v.dueDate ? String(v.dueDate).slice(0, 10) : null,
            })
          }
        } catch (e) {
          errors.push(`investimentos ${id}: ${(e as Error).message}`)
        }
        try {
          const ln = await pget(key, `/loans?itemId=${id}&pageSize=100`)
          for (const l of ln.results ?? []) {
            const ins = (l.installments ?? {}) as Record<string, unknown>
            const pay = (l.payments ?? {}) as Record<string, unknown>
            loans.push({
              itemId: id,
              id: l.id,
              name: l.productName ?? l.type ?? 'Empréstimo',
              type: l.type ?? null,
              contractCents: l.contractAmount != null ? Math.round(Number(l.contractAmount) * 100) : null,
              outstandingCents:
                pay.contractOutstandingBalance != null ? Math.round(Number(pay.contractOutstandingBalance) * 100) : null,
              total: ins.totalNumberOfInstallments ?? null,
              paid: ins.paidInstallments ?? null,
              due: ins.dueInstallments ?? null,
              pastDue: ins.pastDueInstallments ?? null,
              dueDate: l.dueDate ? String(l.dueDate).slice(0, 10) : null,
              cet: l.CET ?? null,
            })
          }
        } catch (e) {
          errors.push(`empréstimos ${id}: ${(e as Error).message}`)
        }
      }
      const at = new Date().toISOString()
      return new Response(JSON.stringify({ ok: true, at, accounts, investments, loans, errors }), { headers })
    }

    if (body.action === 'cards') {
      // cartões: limite (total, usado, disponível), fatura aberta do ciclo atual e últimas faturas fechadas
      const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)
      const addMonths = (iso: string, n: number) => {
        const [y, m, d] = iso.split('-').map(Number)
        const f = new Date(Date.UTC(y!, m! - 1 + n, 1))
        const last = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate()
        return `${f.getUTCFullYear()}-${String(f.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d!, last)).padStart(2, '0')}`
      }
      const out = []
      for (const id of itemIds) {
        const acc = await pget(key, `/accounts?itemId=${id}`)
        for (const a of acc.results ?? []) {
          if (a.type !== 'CREDIT') continue
          const cd = (a.creditData ?? {}) as Record<string, unknown>
          // ciclo aberto: do dia seguinte ao último fechamento até o próximo fechamento
          let nextClose = typeof cd.balanceCloseDate === 'string' ? (cd.balanceCloseDate as string).slice(0, 10) : null
          if (nextClose) while (nextClose < today) nextClose = addMonths(nextClose, 1)
          const cycleFrom = nextClose ? addMonths(nextClose, -1) : addMonths(today, -1)
          const txs: Record<string, unknown>[] = []
          for (let page = 1; page <= 10; page++) {
            const t = await pget(key, `/transactions?accountId=${a.id}&from=${cycleFrom}&to=${today}&pageSize=500&page=${page}`)
            txs.push(...(t.results ?? []))
            if (page >= (t.totalPages ?? 1)) break
          }
          let openCents = 0
          for (const t of txs) {
            const d = String(t.date ?? '').slice(0, 10)
            if (d <= cycleFrom) continue
            const desc = String(t.description ?? '')
            const cents = Math.round(Math.abs(Number(t.amountInAccountCurrency ?? t.amount ?? 0)) * 100)
            if (t.type === 'CREDIT' && /pagamento|pgto|pagto/i.test(desc)) continue // pagamento da fatura anterior
            openCents += t.type === 'CREDIT' ? -cents : cents
          }
          let bills: Record<string, unknown>[] = []
          try {
            const b = await pget(key, `/bills?accountId=${a.id}&pageSize=6`)
            bills = (b.results ?? []) as Record<string, unknown>[]
          } catch {
            bills = []
          }
          out.push({
            itemId: id,
            accountId: a.id,
            name: a.marketingName ?? a.name,
            number: a.number,
            usedCents: Math.round(Number(a.balance ?? 0) * 100),
            limitCents: cd.creditLimit != null ? Math.round(Number(cd.creditLimit) * 100) : null,
            availableCents: cd.availableCreditLimit != null ? Math.round(Number(cd.availableCreditLimit) * 100) : null,
            minimumPaymentCents: cd.minimumPayment != null ? Math.round(Number(cd.minimumPayment) * 100) : null,
            closeDate: nextClose,
            dueDate: typeof cd.balanceDueDate === 'string' ? (cd.balanceDueDate as string).slice(0, 10) : null,
            openCents,
            cycleFrom,
            bills: bills
              .map((b) => ({
                id: b.id,
                dueDate: String(b.dueDate ?? '').slice(0, 10),
                totalCents: Math.round(Number(b.totalAmount ?? 0) * 100),
                paidCents: Math.round(
                  ((b.payments as { amount?: number }[] | undefined) ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100,
                ),
              }))
              .sort((x, y) => (x.dueDate < y.dueDate ? 1 : -1))
              .slice(0, 3),
          })
        }
      }
      return new Response(JSON.stringify({ ok: true, today, cards: out }), { headers })
    }

    if (body.action === 'transactions') {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from ?? '') ? body.from! : new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10)
      const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to ?? '') ? body.to! : new Date().toISOString().slice(0, 10)
      const out = []
      for (const id of itemIds) {
        const it = await pget(key, `/items/${id}`)
        const acc = await pget(key, `/accounts?itemId=${id}`)
        for (const a of acc.results ?? []) {
          const txs: Record<string, unknown>[] = []
          for (let page = 1; page <= 20; page++) {
            const t = await pget(key, `/transactions?accountId=${a.id}&from=${from}&to=${to}&pageSize=500&page=${page}`)
            txs.push(...(t.results ?? []))
            if (page >= (t.totalPages ?? 1)) break
          }
          out.push({
            itemId: id,
            connector: it.connector?.name ?? null,
            account: { id: a.id, type: a.type, subtype: a.subtype, name: a.marketingName ?? a.name, number: a.number },
            transactions: txs.map((t) => ({
              id: t.id,
              date: t.date,
              description: t.description,
              amount: t.amount,
              amountInAccountCurrency: t.amountInAccountCurrency ?? null,
              currencyCode: t.currencyCode,
              type: t.type,
              status: t.status,
              category: t.category ?? null,
              merchant: (t.merchant as { name?: string } | null)?.name ?? null,
              installment: t.creditCardMetadata
                ? {
                    n: (t.creditCardMetadata as Record<string, unknown>).installmentNumber ?? null,
                    of: (t.creditCardMetadata as Record<string, unknown>).totalInstallments ?? null,
                    cardNumber: (t.creditCardMetadata as Record<string, unknown>).cardNumber ?? null,
                  }
                : null,
            })),
          })
        }
      }
      return new Response(JSON.stringify({ ok: true, from, to, accounts: out }), { headers })
    }

    return fail(400, 'Ação desconhecida.')
  } catch (e) {
    return fail(500, (e as Error).message)
  }
})
