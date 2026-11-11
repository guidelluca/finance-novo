/**
 * Planilha da casa (a mesma do app Tocah), lida pela API do Tocah no Render:
 *   GET {api}?action=getFinanceSnapshot&sheet=OUT_2026
 * Cada aba mensal tem uma linha por morador: Aluguel, Água, Luz, Net, IPTU, …, Caixinha, …, TOTAL.
 *
 * Regras combinadas com o usuário:
 *   - O seu gasto da casa no mês = Aluguel + Caixinha da SUA linha.
 *   - O aluguel é pago entre os dias 10 e 15 e confere com a aba do mesmo mês
 *     (aluguel pago em 15/11 ↔ aba NOV_2026).
 *   - O que cada morador te manda de Pix deve bater com o TOTAL da linha dele.
 *
 * A resposta fica guardada no aparelho (localStorage): o cálculo do mês é síncrono e usa a última leitura.
 */
import { parseMoneyToCents } from '@/lib/currency'

export const DEFAULT_SHEET_API = 'https://tocah-do-coelho-app.onrender.com/api'
export const SHEET_EVENT = 'finance:house-sheet'

const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']

export type SheetResident = {
  nome: string
  aluguelCents: number
  caixinhaCents: number
  totalCents: number
  /** demais colunas da linha do morador (versões antigas do cache não têm) */
  aguaCents?: number
  luzCents?: number
  netCents?: number
  iptuCents?: number
  extrasCents?: number
  multasCents?: number
  dividasCents?: number
  contaQuePagaCents?: number
}
export type SheetConta = { conta: string; valorCents: number; divisao: string; vencimento: string; status: string }
export type SheetColetivo = { quem: string; quantoCents: number; oQue: string; obs: string }
export type SheetAcerto = { quem: string; deveCents: number; paraQuem: string; obs: string }
export type SheetMonth = { title: string; label: string; year: number; month: number }

export type HouseSheet = {
  tab: string
  label: string
  fetchedAt: string
  residents: SheetResident[]
  aluguelSumCents: number
  contas?: SheetConta[]
  coletivos?: SheetColetivo[]
  acertos?: SheetAcerto[]
  availableMonths?: SheetMonth[]
}

/**
 * Aba da planilha que confere com um aluguel pago nesta data: a do PRÓPRIO mês
 * (o aluguel de novembro é pago entre 10 e 15/11 → aba NOV_2026).
 * Pago nos primeiros 5 dias do mês = atraso do mês anterior ("2026-12-02" → NOV_2026).
 */
export function sheetTabForPayment(date: string): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7)) // 1..12
  const late = Number(date.slice(8, 10)) <= 5
  const tm = late ? (m === 1 ? 12 : m - 1) : m
  const ty = late && m === 1 ? y - 1 : y
  return `${MONTHS[tm - 1]}_${ty}`
}

const money = (v: unknown): number => {
  const s = String(v ?? '').trim()
  if (!s || /^-+$/.test(s)) return 0
  return parseMoneyToCents(s) ?? 0
}

const cacheKey = (tab: string) => `finance:house-sheet:${tab}`

export function readSheetCache(tab: string): HouseSheet | null {
  try {
    const raw = localStorage.getItem(cacheKey(tab))
    return raw ? (JSON.parse(raw) as HouseSheet) : null
  } catch {
    return null
  }
}

/** Todas as abas já lidas neste aparelho. */
export function readAllSheetCaches(): Record<string, HouseSheet> {
  const out: Record<string, HouseSheet> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith('finance:house-sheet:')) continue
      const v = readSheetCache(k.slice('finance:house-sheet:'.length))
      if (v) out[v.tab] = v
    }
  } catch {
    /* sem armazenamento: segue sem planilha */
  }
  return out
}

/** Lê a aba na API do Tocah. O Render gratuito "dorme": a 1.ª leitura pode levar ~1 minuto. */
export async function fetchHouseSheet(tab: string, api = DEFAULT_SHEET_API): Promise<HouseSheet> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  let res: Response
  try {
    res = await fetch(`${api}?action=getFinanceSnapshot&sheet=${encodeURIComponent(tab)}`, { signal: ctrl.signal })
  } catch (e) {
    throw new Error(
      (e as Error).name === 'AbortError'
        ? 'A planilha demorou demais para responder (o servidor do Tocah pode estar acordando). Tente de novo.'
        : 'Não consegui falar com o servidor da planilha. Confira a internet e tente de novo.',
    )
  } finally {
    clearTimeout(timer)
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    message?: string
    mesReferencia?: string
    mesLabel?: string
    residents?: Record<string, unknown>[]
  } | null
  if (!res.ok || !body?.ok) throw new Error(body?.message ?? `A planilha respondeu com erro ${res.status}.`)
  const residents: SheetResident[] = (body.residents ?? [])
    .map((r) => ({
      nome: String(r.nome ?? '').trim(),
      aluguelCents: money(r.aluguel),
      caixinhaCents: money(r.caixinha),
      totalCents: money(r.total),
      aguaCents: money(r.agua),
      luzCents: money(r.luz),
      netCents: money(r.net),
      iptuCents: money(r.iptu),
      extrasCents: money(r.sofa) + money(r.dryWall),
      multasCents: money(r.multas),
      dividasCents: money(r.dividas),
      contaQuePagaCents: money(r.contaQuePaga),
    }))
    .filter((r) => r.nome && !/^total$/i.test(r.nome))
  const str = (v: unknown) => String(v ?? '').trim()
  const b = body as unknown as {
    contas?: Record<string, unknown>[]
    gastosColetivos?: Record<string, unknown>[]
    acertosIndividuais?: Record<string, unknown>[]
    availableMonths?: SheetMonth[]
  }
  const sheet: HouseSheet = {
    tab: body.mesReferencia ?? tab,
    label: body.mesLabel ?? tab,
    fetchedAt: new Date().toISOString(),
    residents,
    aluguelSumCents: residents.reduce((s, r) => s + r.aluguelCents, 0),
    contas: (b.contas ?? []).map((c) => ({ conta: str(c.conta), valorCents: money(c.valor), divisao: str(c.divisao), vencimento: str(c.vencimento), status: str(c.status) })).filter((c) => c.conta),
    coletivos: (b.gastosColetivos ?? []).map((c) => ({ quem: str(c.quem), quantoCents: money(c.quanto), oQue: str(c.oQue), obs: str(c.obs) })).filter((c) => c.quem && c.quantoCents),
    acertos: (b.acertosIndividuais ?? []).map((c) => ({ quem: str(c.quem), deveCents: money(c.deveQuanto), paraQuem: str(c.paraQuem), obs: str(c.obs) })).filter((c) => c.quem && c.deveCents),
    availableMonths: Array.isArray(b.availableMonths) ? b.availableMonths : undefined,
  }
  try {
    localStorage.setItem(cacheKey(tab), JSON.stringify(sheet))
  } catch {
    /* sem armazenamento: vale só nesta tela */
  }
  window.dispatchEvent(new CustomEvent(SHEET_EVENT))
  return sheet
}

/** Lê várias abas em sequência (o servidor gratuito não aguenta muitas de uma vez). */
export async function fetchHouseMonths(tabs: string[], onProgress?: (done: number, total: number) => void): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = []
  const failed: string[] = []
  for (const [i, t] of tabs.entries()) {
    try {
      await fetchHouseSheet(t)
      ok.push(t)
    } catch {
      failed.push(t)
    }
    onProgress?.(i + 1, tabs.length)
  }
  return { ok, failed }
}

export type CaixinhaItem = { data: string; descricao: string; valorCents: number; obs: string }

/** Extrato da caixinha (aba "Caixinha" da planilha). */
export async function fetchCaixinha(api = DEFAULT_SHEET_API): Promise<CaixinhaItem[]> {
  const res = await fetch(`${api}?action=getCaixinhaStatement`)
  const body = (await res.json().catch(() => null)) as { ok?: boolean; items?: Record<string, unknown>[] } | null
  if (!res.ok || !body?.ok) throw new Error('Não consegui ler a caixinha.')
  const items = (body.items ?? []).map((i) => ({
    data: String(i.data ?? ''),
    descricao: String(i.descricao ?? ''),
    valorCents: money(i.valor),
    obs: String(i.obs ?? ''),
  }))
  try {
    localStorage.setItem('finance:house-caixinha', JSON.stringify({ at: new Date().toISOString(), items }))
  } catch {
    /* sem armazenamento */
  }
  return items
}

export function readCaixinhaCache(): { at: string; items: CaixinhaItem[] } | null {
  try {
    const raw = localStorage.getItem('finance:house-caixinha')
    return raw ? (JSON.parse(raw) as { at: string; items: CaixinhaItem[] }) : null
  } catch {
    return null
  }
}

/** "OUT_2026" → "2026-10" (para ordenar e casar com o extrato). */
export function tabToYm(tab: string): string | null {
  const m = tab.toUpperCase().match(/^([A-Z]{3})_(\d{4})$/)
  if (!m) return null
  const idx = MONTHS.indexOf(m[1]!)
  return idx < 0 ? null : `${m[2]}-${String(idx + 1).padStart(2, '0')}`
}
