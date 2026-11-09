/**
 * Dias e períodos sem NENHUM lançamento no mês (somando todas as contas), e contas que ficaram
 * "mudas" muito mais tempo que o normal delas. Cada trecho vira uma pergunta:
 * "está certo (não gastei nada)" ou "falta lançar". A resposta fica salva na conta (user_metadata).
 */
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { matchAccount, type CoverageTx, type TrackedAccount } from '@/lib/accounts'

export type QuietRun = { key: string; from: string; to: string; days: number; recent: boolean }
export type AccountSilence = { key: string; account: TrackedAccount; from: string; to: string; days: number; usualGap: number }
export type QuietReport = {
  /** 2+ dias seguidos sem nada em nenhuma conta */
  runs: QuietRun[]
  /** dias soltos sem nada (uma pergunta só para todos) */
  singles: string[]
  singlesKey: string
  silences: AccountSilence[]
  pending: number
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)

export function readQuietMarks(user: User | null): Record<string, boolean> {
  const raw = user?.user_metadata?.quiet_ok
  return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
}

export async function setQuietMark(user: User, key: string, ok: boolean): Promise<void> {
  const cur = { ...readQuietMarks(user) }
  if (ok) cur[key] = true
  else delete cur[key]
  const { error } = await supabase.auth.updateUser({ data: { quiet_ok: cur } })
  if (error) throw error
}

export function computeQuietDays(
  bounds: { start: string; end: string },
  today: string,
  txs: CoverageTx[],
  accounts: TrackedAccount[],
  marks: Record<string, boolean>,
): QuietReport {
  // hoje ainda pode não ter nada: confere só até ontem
  const until = bounds.end < today ? bounds.end : addDays(today, -1)
  const empty: QuietReport = { runs: [], singles: [], singlesKey: '', silences: [], pending: 0 }
  if (until < bounds.start) return empty

  const daysWith = new Set(txs.filter((t) => t.date >= bounds.start && t.date <= until).map((t) => t.date))
  // sem nenhum lançamento no mês inteiro: isso já aparece como "falta extrato"
  if (daysWith.size === 0) return empty

  const runs: QuietRun[] = []
  const singles: string[] = []
  let d = bounds.start
  while (d <= until) {
    if (daysWith.has(d)) {
      d = addDays(d, 1)
      continue
    }
    let e = d
    while (addDays(e, 1) <= until && !daysWith.has(addDays(e, 1))) e = addDays(e, 1)
    const days = diffDays(d, e) + 1
    if (days >= 2) runs.push({ key: `dias:${d}:${e}`, from: d, to: e, days, recent: e === until && bounds.end >= today })
    else singles.push(d)
    d = addDays(e, 1)
  }
  const singlesKey = singles.length ? `soltos:${bounds.start}:${singles.join(',')}` : ''

  // conta acostumada a ter movimento quase todo dia que ficou muda bem mais que o normal
  const silences: AccountSilence[] = []
  for (const account of accounts) {
    const dates = [
      ...new Set(txs.filter((t) => matchAccount(accounts, t.account, Boolean(t.credit_card_id))?.id === account.id).map((t) => t.date)),
    ].sort()
    if (dates.length < 8) continue
    const gaps = dates.slice(1).map((x, i) => diffDays(dates[i]!, x)).sort((a, b) => a - b)
    const usualGap = gaps[Math.floor(gaps.length / 2)] ?? 1
    const limit = Math.max(7, usualGap * 4)
    const inMonth = dates.filter((x) => x >= bounds.start && x <= until)
    if (inMonth.length === 0) continue // conta sem nada no mês: o quadro de extratos já pergunta
    const before = dates.filter((x) => x < bounds.start).pop() ?? null
    const points = [before ?? bounds.start, ...inMonth]
    for (let i = 1; i < points.length; i++) {
      const from = addDays(points[i - 1]!, 1) < bounds.start ? bounds.start : addDays(points[i - 1]!, 1)
      const to = addDays(points[i]!, -1)
      const days = diffDays(from, to) + 1
      if (days >= limit) silences.push({ key: `conta:${account.id}:${from}:${to}`, account, from, to, days, usualGap })
    }
    const lastIn = inMonth[inMonth.length - 1]!
    const tail = diffDays(lastIn, until)
    // mês em andamento: o fim sem lançamentos é só extrato/fatura ainda não importado (o quadro de extratos mostra)
    if (tail >= limit && bounds.end < today) {
      const from = addDays(lastIn, 1)
      silences.push({ key: `conta:${account.id}:${from}:${until}`, account, from, to: until, days: tail, usualGap })
    }
  }

  // conta muda num trecho em que nenhuma conta teve nada: a pergunta do trecho geral já cobre
  const covered = (x: { from: string; to: string }) => runs.some((r) => r.from <= x.from && r.to >= x.to)
  const ownSilences = silences.filter((x) => !covered(x))

  const open = {
    runs: runs.filter((r) => !marks[r.key]),
    singles: singlesKey && !marks[singlesKey] ? singles : [],
    silences: ownSilences.filter((s) => !marks[s.key]),
  }
  return {
    runs: open.runs,
    singles: open.singles,
    singlesKey,
    silences: open.silences,
    pending: open.runs.length + (open.singles.length ? 1 : 0) + open.silences.length,
  }
}
