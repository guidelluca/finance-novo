// Open Finance via Meu Pluggy (uso pessoal, só leitura).
// Segredos (Supabase → Edge Functions → Secrets):
//   PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET  → do dashboard da Pluggy (nunca no app nem no GitHub)
//   ALLOWED_USER_ID                         → o seu id de usuário do app (mostrado na tela Open Finance)
// Ações (POST JSON): { action: 'status' | 'refresh' | 'transactions', itemIds: string[], from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
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
