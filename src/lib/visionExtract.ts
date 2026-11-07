/**
 * Extração de transações a partir de imagem(ns) usando Gemini multimodal.
 * O modelo recebe screenshots do extrato (app do banco, cartão, etc.)
 * e devolve JSON estruturado que a UI transforma em TransactionDraft.
 *
 * Falha de forma clara se a chave Gemini não estiver configurada.
 */

export interface VisionTransaction {
  /** ISO YYYY-MM-DD */
  date: string
  /** Texto original (loja/estabelecimento) da linha */
  description: string
  /** Sempre positivo; sinal vem em kind */
  amountBrl: number
  /** debit = saída; credit = entrada */
  kind: 'debit' | 'credit'
  /** Rótulo de conta/cartão detectado (Nubank, Itaú, Nubank cartão…). Opcional. */
  account?: string | null
  /** Últimos 4 dígitos do cartão, se visível */
  cardLast4?: string | null
  /** Confiança 0..1 do modelo */
  confidence?: number
}

export interface VisionExtractResult {
  transactions: VisionTransaction[]
  /** Rótulo global de conta/cartão detectado no cabeçalho, se algum. */
  accountLabel?: string | null
  /** Mês/ano detectado no cabeçalho, se algum (para inferir ano quando linhas mostram só dia/mês). */
  detectedPeriod?: string | null
  /** Avisos livres do modelo (ex.: "linha ilegível"). */
  warnings?: string[]
}

export interface VisionImage {
  mimeType: string
  /** Base64 sem prefixo data: */
  dataBase64: string
}

export function isVisionConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GEMINI_API_KEY?.trim())
}

function visionModelName(): string {
  return import.meta.env.VITE_GEMINI_VISION_MODEL?.trim() ||
    import.meta.env.VITE_GEMINI_MODEL?.trim() ||
    'gemini-2.0-flash'
}

const SYSTEM_INSTRUCTIONS = `Você é um extrator de transações financeiras de screenshots (apps de bancos brasileiros, faturas de cartão, carteiras digitais).

Regras:
- Extraia APENAS transações reais visíveis na imagem. NUNCA invente valores, datas ou descrições.
- Se um campo não estiver claramente legível, omita a transação e adicione um aviso em "warnings".
- Datas em ISO (YYYY-MM-DD). Se a linha só tiver "dia mês" (ex.: "15 out"), use o ano do cabeçalho visível; se não houver, use o ano atual do sistema.
- Se o app mostrar apenas "Hoje" ou "Ontem", use a data mais provável considerando o ano atual e uma data recente.
- Meses em pt-BR: jan/fev/mar/abr/mai/jun/jul/ago/set/out/nov/dez.
- Valores em número puro (não string), sempre positivo. Sinal vai em "kind":
  - "debit"  = gasto / saída / pagamento / compra / débito / transferência enviada
  - "credit" = entrada / crédito / recebimento / estorno / cashback / transferência recebida
- Se detectar cabeçalho "Fatura do cartão", assuma "debit" para as compras da fatura (a menos que apareça "Estorno"/"Crédito").
- Descrição: texto original visível (nome do estabelecimento). Preserve acentuação. Não adicione categoria.
- Ignore saldos, totais, cabeçalhos, subtítulos e datas isoladas (só extraia LINHAS de transação).
- Se identificar o tipo de conta ou cartão no topo (ex.: "Nubank", "Cartão final 1234"), preencha "accountLabel" e/ou "cardLast4" no nível global.
- Retorne o cardLast4 SEM traços nem "final", só 4 dígitos.

Formato de saída (JSON estrito):
{
  "accountLabel": string | null,
  "detectedPeriod": string | null,
  "cardLast4": string | null,
  "transactions": [
    { "date": "YYYY-MM-DD", "description": string, "amountBrl": number, "kind": "debit"|"credit", "account": string|null, "cardLast4": string|null, "confidence": number }
  ],
  "warnings": string[]
}`

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  error?: { message?: string; code?: number }
}

interface GeminiVisionModelOutput {
  accountLabel?: string | null
  detectedPeriod?: string | null
  cardLast4?: string | null
  transactions?: Array<{
    date?: string
    description?: string
    amountBrl?: number | string
    kind?: string
    account?: string | null
    cardLast4?: string | null
    confidence?: number
  }>
  warnings?: string[]
}

/**
 * Chama Gemini multimodal com uma ou várias imagens e um prompt opcional do utilizador.
 * O prompt do sistema é fixo — quem chama pode passar "userHint" para dar contexto
 * extra (ex.: "esta é a fatura do Nubank de outubro").
 */
export async function extractTransactionsFromImages(
  images: VisionImage[],
  userHint?: string,
): Promise<VisionExtractResult> {
  const key = import.meta.env.VITE_GEMINI_API_KEY?.trim()
  if (!key) throw new Error('Chave Gemini não configurada (VITE_GEMINI_API_KEY).')
  if (images.length === 0) throw new Error('Nenhuma imagem fornecida.')

  const model = visionModelName()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`

  const now = new Date()
  const todayIso = now.toISOString().slice(0, 10)
  const currentYear = now.getFullYear()

  const parts: GeminiPart[] = []
  parts.push({
    text: `${SYSTEM_INSTRUCTIONS}\n\nContexto do sistema:\n- Data atual: ${todayIso}\n- Ano atual: ${currentYear}\n${userHint ? `\nDica do utilizador: ${userHint}` : ''}\n\nExtraia todas as transações visíveis nas imagens a seguir.`,
  })
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.dataBase64 } })
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  })

  const data = (await res.json()) as GeminiResponse
  if (!res.ok) {
    const msg = data.error?.message ?? res.statusText
    throw new Error(msg || 'Falha na API Gemini (vision).')
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason
    throw new Error(reason ? `Resposta vazia (${reason}).` : 'Resposta vazia da IA (vision).')
  }

  let parsed: GeminiVisionModelOutput
  try {
    parsed = JSON.parse(text) as GeminiVisionModelOutput
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('A IA não devolveu JSON válido.')
    parsed = JSON.parse(match[0]) as GeminiVisionModelOutput
  }

  const rawTx = parsed.transactions ?? []
  const cleanedTx: VisionTransaction[] = []
  for (const t of rawTx) {
    if (!t.date || !t.description || t.amountBrl == null || !t.kind) continue
    const amount = typeof t.amountBrl === 'string' ? Number(t.amountBrl.replace(',', '.')) : Number(t.amountBrl)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const kind = t.kind === 'credit' || t.kind === 'debit' ? t.kind : 'debit'
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null
    if (!dateOk) continue
    cleanedTx.push({
      date: dateOk,
      description: String(t.description).trim(),
      amountBrl: amount,
      kind,
      account: t.account ?? null,
      cardLast4: t.cardLast4 ? String(t.cardLast4).replace(/\D/g, '').slice(-4) || null : null,
      confidence: typeof t.confidence === 'number' ? t.confidence : undefined,
    })
  }

  return {
    transactions: cleanedTx,
    accountLabel: parsed.accountLabel?.trim() || null,
    detectedPeriod: parsed.detectedPeriod?.trim() || null,
    warnings: (parsed.warnings ?? []).filter((w) => typeof w === 'string' && w.trim().length > 0),
  }
}

/** Utilitário: converte File → base64 sem o prefixo data:. */
export async function fileToVisionImage(file: File): Promise<VisionImage> {
  const buf = await file.arrayBuffer()
  const b64 = arrayBufferToBase64(buf)
  return { mimeType: file.type || 'image/png', dataBase64: b64 }
}

/** Aceita `data:image/...;base64,...` ou blob URL e devolve VisionImage. */
export async function dataUrlToVisionImage(dataUrl: string): Promise<VisionImage> {
  if (dataUrl.startsWith('data:')) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
    if (!match) throw new Error('Data URL inválida.')
    return { mimeType: match[1] || 'image/png', dataBase64: match[2] || '' }
  }
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const buf = await blob.arrayBuffer()
  return { mimeType: blob.type || 'image/png', dataBase64: arrayBufferToBase64(buf) }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
