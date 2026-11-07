import type { ParseResult, TransactionDraft } from '@/parsers/types'
import type { VisionExtractResult } from '@/lib/visionExtract'

let seq = 0
function genTempId(): string {
  seq += 1
  return `screenshot-${Date.now().toString(36)}-${seq.toString(36)}`
}

/**
 * Converte o output do LLM multimodal em `TransactionDraft[]`, reutilizando
 * a mesma pipeline de import (dedup, categorias, regras) do ImportPage.
 */
export function draftsFromVisionResult(result: VisionExtractResult): ParseResult {
  const drafts: TransactionDraft[] = []
  const warnings: string[] = [...(result.warnings ?? [])]

  const globalAccount = buildAccountLabel(result.accountLabel, undefined)

  for (const t of result.transactions) {
    const cents = Math.round(t.amountBrl * 100)
    if (!Number.isFinite(cents) || cents <= 0) {
      warnings.push(`Linha ignorada (valor inválido): ${t.description}`)
      continue
    }
    const perTxAccount = buildAccountLabel(t.account ?? null, t.cardLast4 ?? null)
    drafts.push({
      tempId: genTempId(),
      date: t.date,
      amountCents: cents,
      kind: t.kind,
      descriptionRaw: t.description,
      categoryId: null,
      categoryHint: null,
      accountHint: perTxAccount ?? globalAccount ?? null,
      sourceId: null,
    })
  }

  return { drafts, warnings }
}

function buildAccountLabel(
  base: string | null | undefined,
  cardLast4: string | null | undefined,
): string | null {
  const clean = (base ?? '').trim()
  const four = (cardLast4 ?? '').replace(/\D/g, '').slice(-4)
  if (!clean && !four) return null
  if (clean && four) return `${clean} • final ${four}`
  if (clean) return clean
  return `Cartão final ${four}`
}
