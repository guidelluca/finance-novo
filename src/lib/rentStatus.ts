import type { User } from '@supabase/supabase-js'
import { readHouseWithSheets, selfResident } from '@/lib/house'
import { monthsFrom, reconcileMonth } from '@/lib/houseAnalysis'
import { sheetTabForPayment } from '@/lib/houseSheet'
import type { RowTx } from '@/lib/ofInsights'

/** Moradores que ainda não mandaram o Pix do aluguel do mês (só depois do dia 16, quando o aluguel já foi pago). */
export function rentMissingNow(user: User | null, txs: RowTx[], today: string): string[] {
  if (Number(today.slice(8, 10)) < 16) return []
  const house = readHouseWithSheets(user)
  if (!house.sheets) return []
  const tab = sheetTabForPayment(today)
  const m = monthsFrom(house.sheets).find((x) => x.tab === tab)
  if (!m) return []
  const owner = (user?.user_metadata?.owner_name as string | undefined) ?? null
  const self = selfResident(m.sheet.residents, house, owner)
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  const payeeRe = new RegExp(house.payees.map((p) => fold(p).split(' ')[0]).join('|') || 'lanza')
  const r = reconcileMonth(m, txs, self?.nome ?? owner, payeeRe)
  return r.rows.filter((x) => x.status === 'sem_pix' || x.status === 'falta').map((x) => (x.status === 'falta' ? `${x.nome} (pagou menos)` : x.nome))
}
