import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/**
 * Finanças da casa (república) que passam pela conta do usuário como tesoureiro:
 * aluguel pago à imobiliária, Pix dos moradores (aluguel/caixinha) e a caixinha.
 * Nada disso é gasto/renda pessoal: sai dos totais pessoais e aparece na tela Casa.
 */
export type HouseConfig = {
  name: string
  /** nomes completos dos moradores que mandam/recebem dinheiro da casa */
  members: string[]
  /** para quem a casa paga (imobiliária, condomínio, contas da casa) */
  payees: string[]
  /** palavras na descrição que indicam a casa (ex.: "caixinha") */
  keywords: string[]
  /** marcações feitas à mão: lançamento → da casa / meu */
  tx: Record<string, 'casa' | 'meu'>
  /** valor total da caixinha em cada mês ("2026-11" → centavos), dividido igualmente entre os moradores */
  caixinha: Record<string, number>
  /** quantas pessoas moram na casa e dividem a caixinha (você incluído) */
  people: number
}

export const DEFAULT_HOUSE: HouseConfig = {
  name: 'República',
  members: ['Luísa Stolf', 'Vitor Stolf', 'Maria Cida Padilha', 'Alan Daniel Martins Lima', 'Ramon Domingues'],
  payees: ['Lanza Imóveis'],
  keywords: ['caixinha'],
  tx: {},
  caixinha: {},
  people: 5,
}

export function readHouse(user: User | null): HouseConfig {
  const raw = user?.user_metadata?.house as Partial<HouseConfig> | undefined
  if (!raw || typeof raw !== 'object') return DEFAULT_HOUSE
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : DEFAULT_HOUSE.name,
    members: Array.isArray(raw.members) ? raw.members.filter((m) => typeof m === 'string') : DEFAULT_HOUSE.members,
    payees: Array.isArray(raw.payees) ? raw.payees.filter((m) => typeof m === 'string') : DEFAULT_HOUSE.payees,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((m) => typeof m === 'string') : DEFAULT_HOUSE.keywords,
    tx: raw.tx && typeof raw.tx === 'object' ? (raw.tx as HouseConfig['tx']) : {},
    caixinha: raw.caixinha && typeof raw.caixinha === 'object' ? (raw.caixinha as HouseConfig['caixinha']) : {},
    people: typeof raw.people === 'number' && raw.people >= 1 ? Math.round(raw.people) : DEFAULT_HOUSE.people,
  }
}

export async function saveHouse(cfg: HouseConfig): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: { house: cfg } })
  if (error) throw error
}

/** minúsculas, sem acento, sem letra dobrada ("Allan" = "Alan"), espaços simples */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Nome de quem mandou/recebeu, como cada banco escreve. */
export function counterparty(desc: string): string {
  const d = desc.replace(/\s*·\s*conta pr[oó]pria$/i, '').trim()
  const itau = d.match(/^pix (?:transf|cart[aã]o)\s+(.+?)\s?(\d{2}\/\d{2})?$/i) // "PIX TRANSF ALLAN D29/05"
  if (itau) return itau[1]!
  const nu = d.match(/pelo pix\s*[-–]\s*([^-•–]+)/i) // "Transferência recebida pelo Pix - VITOR STOLF - •••…"
  if (nu) return nu[1]!
  const inter = d.match(/^pix (?:recebido|enviado)\s*:\s*(?:cp\s*:\s*\d+\s*-\s*)?(.+)$/i) // "Pix recebido: Cp :123-Fulano"
  if (inter) return inter[1]!
  const ted = d.match(/^(?:ted|doc|tef)\s+(?:[\d.]+\.)?(.+)$/i)
  if (ted) return ted[1]!
  return d
}

/** Morador que aparece na descrição (Itaú corta o nome: "ALLAN D" = Alan Daniel …). */
export function memberOf(desc: string, cfg: HouseConfig): string | null {
  const cp = foldName(counterparty(desc))
  const whole = foldName(desc)
  for (const m of cfg.members) {
    const fm = foldName(m)
    if (!fm) continue
    if (cp.length >= 5 && fm.startsWith(cp)) return m
    if (whole.includes(fm)) return m
    const parts = fm.split(' ')
    if (parts.length >= 2) {
      const first = parts[0]!
      const last = parts[parts.length - 1]!
      const words = new Set(cp.split(' '))
      if (words.has(first) && words.has(last)) return m
    }
  }
  return null
}

export type HouseClass = { kind: 'casa' | 'talvez'; who: string; why: 'manual' | 'pagamento' | 'morador' | 'caixinha' }

/**
 * Da casa?
 * - marcado à mão → manda;
 * - pagamento para a imobiliária/conta da casa ou "caixinha" na descrição → casa;
 * - dinheiro que um morador mandou → casa (aluguel/caixinha);
 * - dinheiro que você mandou para um morador → "talvez" (pode ser pessoal: dividir conta, presente…).
 */
export function classifyHouse(
  t: { id: string; description: string; kind: 'debit' | 'credit' },
  cfg: HouseConfig | null,
): HouseClass | null {
  if (!cfg) return null
  const manual = cfg.tx[t.id]
  if (manual === 'meu') return null
  const fd = foldName(t.description)
  const payee = cfg.payees.find((p) => {
    const fp = foldName(p)
    const key = fp.split(' ')[0] ?? ''
    return fp && (fd.includes(fp) || (key.length >= 4 && fd.split(' ').includes(key)))
  })
  if (manual === 'casa') return { kind: 'casa', who: payee ?? memberOf(t.description, cfg) ?? 'marcado por você', why: 'manual' }
  if (payee) return { kind: 'casa', who: payee, why: 'pagamento' }
  const kw = cfg.keywords.find((k) => k && fd.includes(foldName(k)))
  if (kw) return { kind: 'casa', who: memberOf(t.description, cfg) ?? kw, why: 'caixinha' }
  const m = memberOf(t.description, cfg)
  if (m) return t.kind === 'credit' ? { kind: 'casa', who: m, why: 'morador' } : { kind: 'talvez', who: m, why: 'morador' }
  return null
}

export async function markHouseTx(user: User, txId: string, value: 'casa' | 'meu' | null): Promise<HouseConfig> {
  const cfg = readHouse(user)
  const tx = { ...cfg.tx }
  if (value) tx[txId] = value
  else delete tx[txId]
  const next = { ...cfg, tx }
  await saveHouse(next)
  return next
}

/** Sua parte da caixinha no mês (total ÷ moradores). */
export function caixinhaShare(cfg: HouseConfig | null, month: string): { totalCents: number; shareCents: number; people: number } {
  const totalCents = cfg?.caixinha?.[month] ?? 0
  const people = Math.max(1, cfg?.people ?? DEFAULT_HOUSE.people)
  return { totalCents, shareCents: Math.round(totalCents / people), people }
}

export async function setCaixinha(user: User, month: string, cents: number | null, people?: number): Promise<HouseConfig> {
  const cfg = readHouse(user)
  const caixinha = { ...cfg.caixinha }
  if (cents && cents > 0) caixinha[month] = cents
  else delete caixinha[month]
  const next = { ...cfg, caixinha, people: people && people >= 1 ? Math.round(people) : cfg.people }
  await saveHouse(next)
  return next
}
