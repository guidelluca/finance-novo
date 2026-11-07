/** Groq Cloud (OpenAI-compatible). Tier gratuito — chave em https://console.groq.com/keys */

export function isGroqConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GROQ_API_KEY?.trim())
}

/** 8b instant costuma ter TPM mais folgado que 70b no free tier; sobrescreve com VITE_GROQ_MODEL. */
function groqModel(): string {
  return import.meta.env.VITE_GROQ_MODEL?.trim() || 'llama-3.1-8b-instant'
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

/** Resposta longa raramente precisa disto; valores altos esgotam TPM (tokens/min) no free tier. */
const MAX_OUT_TEXT = 4096
const MAX_OUT_JSON = 3072

type GroqChatResponse = {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

function groqRetryDelayMs(message: string): number | null {
  const m = message.match(/try again in ([\d.]+)\s*s/i)
  if (m) {
    const sec = Math.min(Math.max(parseFloat(m[1]) || 1, 1), 90)
    return Math.ceil(sec * 1000) + 400
  }
  if (/rate limit|tpm|tokens per minute/i.test(message)) return 12_000
  return null
}

async function groqChat(body: Record<string, unknown>): Promise<string> {
  const key = import.meta.env.VITE_GROQ_API_KEY?.trim()
  if (!key) throw new Error('Chave Groq não configurada (VITE_GROQ_API_KEY).')

  const maxAttempts = 4
  let lastMsg = 'Falha na API Groq.'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })

    const data = (await res.json()) as GroqChatResponse
    if (res.ok) {
      const text = data.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error('Resposta vazia da Groq.')
      return text
    }

    lastMsg = data.error?.message ?? res.statusText ?? lastMsg
    const wait = groqRetryDelayMs(lastMsg)
    if (wait != null && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(lastMsg || 'Falha na API Groq.')
  }

  throw new Error(lastMsg)
}

export async function groqGenerateText(prompt: string): Promise<string> {
  return groqChat({
    model: groqModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.45,
    max_tokens: MAX_OUT_TEXT,
  })
}

export async function groqGenerateJson<T>(prompt: string): Promise<T> {
  const content = await groqChat({
    model: groqModel(),
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nResponde apenas com um único objeto JSON válido, sem texto antes ou depois, sem markdown.`,
      },
    ],
    temperature: 0.2,
    max_tokens: MAX_OUT_JSON,
    response_format: { type: 'json_object' },
  })

  try {
    return JSON.parse(content) as T
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as T
    throw new Error('A Groq não devolveu JSON válido.')
  }
}
