/**
 * Ordem: por omissão Gemini → Groq (quota, chave inválida, etc.).
 * VITE_FINANCE_LLM_ORDER:
 *   - groq-first — tenta Groq antes do Gemini
 *   - groq-only — só Groq (ignora VITE_GEMINI_API_KEY por completo)
 *
 * Produção: variáveis VITE_GEMINI_API_KEY / VITE_GROQ_API_KEY têm de existir **no build** (CI/hosting).
 * Alternativa: VITE_FINANCE_LLM_VIA_EDGE=true + Edge Function `finance-llm` com secrets na Supabase
 * (chaves não vão no bundle).
 */
import { financeLlmEdgeGenerate, isFinanceLlmEdgeEnabled } from '@/lib/financeLlmEdge'
import { geminiGenerateJson, geminiGenerateText, isGeminiConfigured } from '@/lib/gemini'
import { groqGenerateJson, groqGenerateText, isGroqConfigured } from '@/lib/groq'

export function isFinanceLlmConfigured(): boolean {
  if (isFinanceLlmEdgeEnabled()) return true
  if (isGroqOnlyOrder() && isGroqConfigured()) return true
  return isGeminiConfigured() || isGroqConfigured()
}

function financeLlmOrder(): 'gemini-first' | 'groq-first' | 'groq-only' {
  const raw = import.meta.env.VITE_FINANCE_LLM_ORDER?.trim().toLowerCase() ?? ''
  if (raw === 'groq-only' || raw === 'groq_only') return 'groq-only'
  if (raw === 'groq-first' || raw === 'groq_first') return 'groq-first'
  return 'gemini-first'
}

function isGroqOnlyOrder(): boolean {
  return financeLlmOrder() === 'groq-only'
}

function preferGroqFirst(): boolean {
  return financeLlmOrder() === 'groq-first'
}

function geminiEnabledForClient(): boolean {
  return isGeminiConfigured() && !isGroqOnlyOrder()
}

function isRetryablePrimaryError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('limite') ||
    msg.includes('exhausted') ||
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('try again later')
  )
}

function isGeminiKeyOrAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (msg.includes('api key not valid') || msg.includes('invalid api key')) return true
  if (msg.includes('please pass a valid api key')) return true
  if (msg.includes('api_key_invalid') || msg.includes('permission_denied')) return true
  if (msg.includes('401') || msg.includes('403')) return true
  if (msg.includes('not a valid') && msg.includes('key')) return true
  return false
}

function geminiKeyHelp(): string {
  return (
    'Chave Gemini recusada. Gera uma nova em https://aistudio.google.com/apikey e cola em VITE_GEMINI_API_KEY (sem aspas). ' +
    'Na Vercel: Environment Variables + Redeploy. ' +
    'Ou usa só Groq: VITE_FINANCE_LLM_ORDER=groq-first e VITE_GROQ_API_KEY em https://console.groq.com/keys .'
  )
}

function parseJsonFromEdgeText<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as T
    throw new Error('A IA não devolveu JSON válido.')
  }
}

export async function financeLlmGenerateText(prompt: string): Promise<string> {
  if (isFinanceLlmEdgeEnabled()) {
    return financeLlmEdgeGenerate(prompt, false)
  }

  const canGroq = isGroqConfigured()
  const canGemini = geminiEnabledForClient()

  if (isGroqOnlyOrder()) {
    if (!canGroq) {
      throw new Error(
        'Modo groq-only: define VITE_GROQ_API_KEY (local e build de produção) ou remove VITE_FINANCE_LLM_ORDER=groq-only.',
      )
    }
    return groqGenerateText(prompt)
  }

  if (!canGemini && !canGroq) {
    throw new Error(
      'Nenhuma IA configurada. Opções: (1) VITE_GEMINI_API_KEY e/ou VITE_GROQ_API_KEY no .env local e nas variáveis de ambiente do **build** de produção + redeploy; (2) VITE_FINANCE_LLM_VIA_EDGE=true e deploy da função `finance-llm` com secrets GEMINI_API_KEY/GROQ_API_KEY na Supabase.',
    )
  }

  if (preferGroqFirst() && canGroq) {
    try {
      return await groqGenerateText(prompt)
    } catch (eGroq) {
      if (canGemini) {
        try {
          return await geminiGenerateText(prompt)
        } catch (eGem) {
          throw new Error(
            `Groq: ${eGroq instanceof Error ? eGroq.message : String(eGroq)} · Gemini: ${eGem instanceof Error ? eGem.message : String(eGem)}`,
          )
        }
      }
      throw eGroq
    }
  }

  if (canGemini) {
    try {
      return await geminiGenerateText(prompt)
    } catch (e) {
      if (canGroq && (isRetryablePrimaryError(e) || isGeminiKeyOrAuthError(e))) {
        try {
          return await groqGenerateText(prompt)
        } catch (e2) {
          throw new Error(
            `Gemini: ${e instanceof Error ? e.message : String(e)} · Groq: ${e2 instanceof Error ? e2.message : String(e2)}`,
          )
        }
      }
      if (isGeminiKeyOrAuthError(e) && !canGroq) {
        throw new Error(`${geminiKeyHelp()} (Erro: ${e instanceof Error ? e.message : String(e)})`)
      }
      throw e
    }
  }

  return groqGenerateText(prompt)
}

export async function financeLlmGenerateJson<T>(prompt: string): Promise<T> {
  if (isFinanceLlmEdgeEnabled()) {
    const text = await financeLlmEdgeGenerate(prompt, true)
    return parseJsonFromEdgeText<T>(text)
  }

  const canGroq = isGroqConfigured()
  const canGemini = geminiEnabledForClient()

  if (isGroqOnlyOrder()) {
    if (!canGroq) {
      throw new Error(
        'Modo groq-only: define VITE_GROQ_API_KEY (local e build de produção) ou remove VITE_FINANCE_LLM_ORDER=groq-only.',
      )
    }
    return groqGenerateJson<T>(prompt)
  }

  if (!canGemini && !canGroq) {
    throw new Error(
      'Nenhuma IA configurada. Opções: (1) VITE_GEMINI_API_KEY e/ou VITE_GROQ_API_KEY no .env local e nas variáveis de ambiente do **build** de produção + redeploy; (2) VITE_FINANCE_LLM_VIA_EDGE=true e deploy da função `finance-llm` com secrets GEMINI_API_KEY/GROQ_API_KEY na Supabase.',
    )
  }

  if (preferGroqFirst() && canGroq) {
    try {
      return await groqGenerateJson<T>(prompt)
    } catch (eGroq) {
      if (canGemini) {
        try {
          return await geminiGenerateJson<T>(prompt)
        } catch (eGem) {
          throw new Error(
            `Groq: ${eGroq instanceof Error ? eGroq.message : String(eGroq)} · Gemini: ${eGem instanceof Error ? eGem.message : String(eGem)}`,
          )
        }
      }
      throw eGroq
    }
  }

  if (canGemini) {
    try {
      return await geminiGenerateJson<T>(prompt)
    } catch (e) {
      if (canGroq && (isRetryablePrimaryError(e) || isGeminiKeyOrAuthError(e))) {
        try {
          return await groqGenerateJson<T>(prompt)
        } catch (e2) {
          throw new Error(
            `Gemini: ${e instanceof Error ? e.message : String(e)} · Groq: ${e2 instanceof Error ? e2.message : String(e2)}`,
          )
        }
      }
      if (isGeminiKeyOrAuthError(e) && !canGroq) {
        throw new Error(`${geminiKeyHelp()} (Erro: ${e instanceof Error ? e.message : String(e)})`)
      }
      throw e
    }
  }

  return groqGenerateJson<T>(prompt)
}
