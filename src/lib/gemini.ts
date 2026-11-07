/** Usa a API Gemini (camada gratuita do Google AI Studio). A chave fica no cliente — restrinja por domínio no Google Cloud. */

export function isGeminiConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GEMINI_API_KEY?.trim())
}

function modelName(): string {
  return import.meta.env.VITE_GEMINI_MODEL?.trim() || 'gemini-2.0-flash'
}

type GeminiPart = { text?: string }

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  error?: { message?: string; code?: number }
}

export async function geminiGenerateText(prompt: string): Promise<string> {
  const key = import.meta.env.VITE_GEMINI_API_KEY?.trim()
  if (!key) throw new Error('Chave Gemini não configurada (VITE_GEMINI_API_KEY).')

  const model = modelName()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: 8192,
      },
    }),
  })

  const data = (await res.json()) as GeminiResponse
  if (!res.ok) {
    const msg = data.error?.message ?? res.statusText
    throw new Error(msg || 'Falha na API Gemini.')
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason
    throw new Error(reason ? `Resposta vazia (${reason}).` : 'Resposta vazia da IA.')
  }
  return text
}

export async function geminiGenerateJson<T>(prompt: string): Promise<T> {
  const key = import.meta.env.VITE_GEMINI_API_KEY?.trim()
  if (!key) throw new Error('Chave Gemini não configurada (VITE_GEMINI_API_KEY).')

  const model = modelName()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  })

  const data = (await res.json()) as GeminiResponse
  if (!res.ok) {
    const msg = data.error?.message ?? res.statusText
    throw new Error(msg || 'Falha na API Gemini.')
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason
    throw new Error(reason ? `Resposta vazia (${reason}).` : 'Resposta vazia da IA.')
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as T
    throw new Error('A IA não devolveu JSON válido.')
  }
}
