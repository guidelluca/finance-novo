/**
 * Open Finance pelo Meu Pluggy: o app chama a função "pluggy-sync" no Supabase (que guarda a chave da Pluggy)
 * e transforma as transações em lançamentos para a mesma revisão da importação de arquivos.
 * Conexões (itemId + banco) ficam no user_metadata; o itemId sozinho não dá acesso a nada sem a chave.
 */
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { TransactionDraft } from '@/parsers/types'

export const OF_BANKS = ['Itaú', 'Nubank', 'Mercado Pago', 'PicPay', 'Banco Inter', 'Outro'] as const
export type OfConnection = { itemId: string; bank: string }

export function readConnections(user: User | null): OfConnection[] {
  const raw = user?.user_metadata?.pluggy_items
  return Array.isArray(raw) ? (raw as OfConnection[]).filter((c) => c && typeof c.itemId === 'string') : []
}

export async function saveConnections(list: OfConnection[]): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: { pluggy_items: list } })
  if (error) throw error
}

export function lastSync(user: User | null): string | null {
  const v = user?.user_metadata?.pluggy_last_sync
  return typeof v === 'string' ? v : null
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('pluggy-sync', { body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    const status = ctx && typeof ctx.status === 'number' ? ctx.status : null
    let msg = error.message
    try {
      const j = ctx ? await ctx.clone().json() : null
      if (j?.message) msg = j.message
    } catch {
      /* corpo não é JSON */
    }
    if (status === 404) {
      msg = 'Não achei a função "pluggy-sync" no Supabase. Confira no passo 4 se ela foi publicada com esse nome exato (tudo minúsculo, com hífen).'
    } else if (status === 401 && !/entre no app/i.test(msg)) {
      msg = 'O Supabase recusou o login ao chamar a função. Saia e entre de novo no app e tente outra vez.'
    } else if (error.name === 'FunctionsFetchError' || /Failed to send|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      msg =
        'Não consegui falar com a função "pluggy-sync". Se ainda não publicou, faça o passo 4. Se já publicou: confira o nome exato, espere 1 minuto e tente de novo.'
    }
    throw new Error(msg)
  }
  if (!data?.ok) throw new Error(data?.message ?? 'Falha no Open Finance.')
  return data as T
}

export type OfItemStatus = {
  id: string
  status?: string
  executionStatus?: string | null
  connector?: string | null
  lastUpdatedAt?: string | null
  accounts?: { id: string; type: string; subtype: string; name: string; number: string; balance: number }[]
  error?: string
}

export const ofStatus = (itemIds: string[]) => call<{ items: OfItemStatus[] }>({ action: 'status', itemIds })
export const ofRefresh = (itemIds: string[]) => call<{ items: { id: string; ok: boolean; status: string | null; message: string | null }[] }>({ action: 'refresh', itemIds })

type OfTx = {
  id: string
  date: string
  description: string
  amount: number
  amountInAccountCurrency: number | null
  currencyCode: string
  type: 'DEBIT' | 'CREDIT'
  status: string
  category: string | null
  merchant: string | null
  installment: { n: number | null; of: number | null; cardNumber: string | null } | null
}
type OfAccount = { itemId: string; connector: string | null; account: { id: string; type: string; subtype: string; name: string; number: string }; transactions: OfTx[] }

/** Data no fuso de São Paulo ("2026-11-10T02:30:00Z" ainda é dia 09). */
function localDate(iso: string): string {
  if (/T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10)
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10)
}

const PAYMENT = /pagamento (recebido|de fatura|fatura)|pgto fatura|pagto fatura|pag fatura/i

/** Busca as transações das conexões e devolve lançamentos prontos para revisão. */
export async function fetchOpenFinanceDrafts(conns: OfConnection[], from: string, to: string): Promise<{ drafts: TransactionDraft[]; warnings: string[] }> {
  const r = await call<{ from: string; to: string; accounts: OfAccount[] }>({ action: 'transactions', itemIds: conns.map((c) => c.itemId), from, to })
  const bankOf = new Map(conns.map((c) => [c.itemId, c.bank]))
  const drafts: TransactionDraft[] = []
  const warnings: string[] = []
  let pending = 0
  for (const a of r.accounts) {
    const bank = bankOf.get(a.itemId) ?? a.connector ?? 'Banco'
    const isCard = a.account.type === 'CREDIT'
    const account = isCard ? `Cartão ${bank.replace(/^Banco\s+/i, '')}` : bank
    const last4 = String(a.account.number ?? '').replace(/\D/g, '').slice(-4) || null
    for (const t of a.transactions) {
      const value = Math.abs(t.amountInAccountCurrency ?? t.amount)
      const cents = Math.round(value * 100)
      if (!cents) continue
      const inst = t.installment?.n && t.installment.of && t.installment.of > 1 ? ` (parcela ${t.installment.n}/${t.installment.of})` : ''
      const desc = `${(t.description || t.merchant || 'Sem descrição').replace(/\s+/g, ' ').trim()}${inst}`
      const kind = t.type === 'CREDIT' ? 'credit' : 'debit'
      // no cartão, "pagamento recebido" é a fatura paga pela conta: já aparece no extrato do banco
      const cardPayment = isCard && kind === 'credit' && PAYMENT.test(desc)
      if (t.status === 'PENDING') pending += 1
      drafts.push({
        tempId: `of-${t.id}`,
        // id da transação na Pluggy: sincronizar de novo não duplica
        sourceId: `pluggy:${t.id}`,
        date: localDate(t.date),
        amountCents: cents,
        kind,
        descriptionRaw: desc,
        accountHint: account,
        cardLast4: isCard ? (t.installment?.cardNumber?.replace(/\D/g, '').slice(-4) || last4) : null,
        excluded: cardPayment,
        reviewFlags: [
          ...(cardPayment ? ['pagamento da fatura: não é compra (o débito aparece no extrato do banco)'] : []),
          ...(t.status === 'PENDING' ? ['ainda pendente no banco: pode mudar de valor ou sumir'] : []),
          ...(t.currencyCode && t.currencyCode !== 'BRL' && t.amountInAccountCurrency == null ? [`valor em ${t.currencyCode}: confira o valor em reais`] : []),
        ],
      })
    }
  }
  drafts.sort((x, y) => (x.date < y.date ? 1 : -1))
  warnings.push(`Open Finance (Meu Pluggy): ${drafts.length} lançamento(s) de ${r.accounts.length} conta(s)/cartão(ões), de ${r.from.split('-').reverse().join('/')} a ${r.to.split('-').reverse().join('/')}.`)
  if (pending) warnings.push(`${pending} lançamento(s) ainda pendente(s) no banco.`)
  await supabase.auth.updateUser({ data: { pluggy_last_sync: new Date().toISOString() } }).catch(() => undefined)
  return { drafts, warnings }
}
