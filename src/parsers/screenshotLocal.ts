/**
 * Prints de apps bancários lidos NO APARELHO (Tesseract.js): grátis e sem limite.
 * Alternativa à extração por IA (visionExtract): mesma saída (TransactionDraft[]),
 * então reaproveita a revisão, dedup e categorias do ImportPage.
 */
import { ocrScreenshot } from '@/lib/localOcr'
import { normalizeScreenshotResponse } from '@/parsers/screenshotNormalize'
import { parseOcrPages, type OcrPage } from '@/parsers/screenshotOcrParse'
import type { ParseResult, TransactionDraft } from '@/parsers/types'

function isoToday(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function detectBankFromText(text: string): string | null {
  const t = text.toLowerCase()
  if (/\bnubank\b|\bnu\s?conta\b/.test(t)) return 'Nubank'
  if (/ita[uú]/.test(t)) return 'Itaú'
  if (/mercado\s?pago/.test(t)) return 'Mercado Pago'
  if (/picpay/.test(t)) return 'PicPay'
  if (/\binter\b/.test(t)) return 'Inter'
  if (/\bc6\b/.test(t)) return 'C6 Bank'
  if (/bradesco/.test(t)) return 'Bradesco'
  if (/santander/.test(t)) return 'Santander'
  if (/caixa/.test(t)) return 'Caixa'
  return null
}

let seq = 0

export async function parseScreenshotsLocally(
  files: File[],
  onProgress?: (msg: string) => void,
): Promise<ParseResult & { bank: string | null }> {
  const today = isoToday()
  const pages: OcrPage[] = []
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `print ${i + 1}/${files.length}` : 'print'
    pages.push(
      await ocrScreenshot(files[i]!, (pct, status) => {
        if (/load|initializ/i.test(status) && pct < 1) {
          onProgress?.(`Preparando leitor (só na 1ª vez)… ${Math.round(pct * 100)}%`)
        } else if (/recogniz/i.test(status)) {
          onProgress?.(`Lendo ${label}… ${Math.round(pct * 100)}%`)
        }
      }),
    )
  }
  onProgress?.('Organizando transações…')
  const { rows } = parseOcrPages(pages, today)
  const norm = normalizeScreenshotResponse({ rows }, today)
  const bank = detectBankFromText(pages.flatMap((p) => p.lines.map((l) => l.text)).join(' '))
  const drafts: TransactionDraft[] = norm.rows.map((r) => ({
    tempId: `ocr-${Date.now().toString(36)}-${(seq += 1)}`,
    date: r.date,
    amountCents: r.amountCents,
    kind: r.kind,
    descriptionRaw: r.descriptionRaw,
    categoryId: null,
    accountHint: bank,
    reviewFlags: r.flags,
    excluded: r.excludeByDefault,
  }))
  const warnings = [...norm.warnings]
  if (drafts.some((d) => d.reviewFlags?.length)) {
    warnings.push('Leitura feita no aparelho. Confira os itens marcados antes de salvar.')
  }
  return { drafts, warnings, bank }
}
