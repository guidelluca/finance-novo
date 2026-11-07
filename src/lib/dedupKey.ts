/**
 * Mesma lógica que `logical_fingerprint` na base (migração
 * transactions_logical_dedupe): coalesce(nullif(trim(norm),''), trim(raw)) em minúsculas.
 */
export function normalizeTransactionLogicalDescription(
  descriptionNormalized: string | null | undefined,
  descriptionRaw: string,
): string {
  const t = descriptionNormalized?.trim() ?? ''
  const base = t.length > 0 ? t : descriptionRaw.trim()
  return base.toLowerCase()
}

/** Chave legível para sets em memória (import); alinhada com a coluna SQL. */
export function transactionContentFingerprint(
  date: string,
  amountCents: number,
  kind: 'debit' | 'credit',
  descriptionNormalized: string | null | undefined,
  descriptionRaw: string,
): string {
  const logical = normalizeTransactionLogicalDescription(descriptionNormalized, descriptionRaw)
  return `${date}|${amountCents}|${kind}|${logical}`
}

/** Chave única por utilizador para impedir reimportar a mesma linha. */
function normalizeDescriptionForFp(descriptionRaw: string): string {
  return descriptionRaw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 400)
}

async function hashSha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function transactionLegacyDedupKey(
  userId: string,
  date: string,
  amountCents: number,
  kind: 'debit' | 'credit',
  descriptionRaw: string,
  externalSourceId?: string | null,
): Promise<string> {
  const ext = externalSourceId?.trim()
  if (ext) return `src:${userId}:${ext.slice(0, 256)}`
  const legacyNorm = descriptionRaw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 400)
  const basis = `${userId}|${date}|${amountCents}|${kind}|${legacyNorm}`
  return `fp:${await hashSha256Hex(basis)}`
}

export async function transactionDedupKey(
  userId: string,
  date: string,
  amountCents: number,
  kind: 'debit' | 'credit',
  descriptionRaw: string,
  externalSourceId?: string | null,
  account?: string | null,
  sourceNamespace?: string | null,
): Promise<string> {
  const ext = externalSourceId?.trim()
  if (ext) {
    const ns = (sourceNamespace ?? 'generic').trim().toLowerCase().slice(0, 40)
    return `src:${userId}:${ns}:${ext.slice(0, 256)}`
  }
  const norm = normalizeDescriptionForFp(descriptionRaw)
  const acc = (account ?? '').trim().toLowerCase().slice(0, 80)
  const basis = `${userId}|${date}|${amountCents}|${kind}|${acc}|${norm}`
  return `fp:${await hashSha256Hex(basis)}`
}

export async function transactionDedupCandidates(
  userId: string,
  date: string,
  amountCents: number,
  kind: 'debit' | 'credit',
  descriptionRaw: string,
  externalSourceId?: string | null,
  account?: string | null,
  sourceNamespace?: string | null,
): Promise<string[]> {
  const primary = await transactionDedupKey(
    userId,
    date,
    amountCents,
    kind,
    descriptionRaw,
    externalSourceId,
    account,
    sourceNamespace,
  )
  const legacy = await transactionLegacyDedupKey(
    userId,
    date,
    amountCents,
    kind,
    descriptionRaw,
    externalSourceId,
  )
  return primary === legacy ? [primary] : [primary, legacy]
}
