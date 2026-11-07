import { supabase } from '@/lib/supabase'

/** Usa a Edge Function `finance-llm` (chaves só nos secrets da Supabase, não no bundle Vite). */
export function isFinanceLlmEdgeEnabled(): boolean {
  const v = import.meta.env.VITE_FINANCE_LLM_VIA_EDGE?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export async function financeLlmEdgeGenerate(prompt: string, jsonMode: boolean): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ text?: string; error?: string }>('finance-llm', {
    body: { prompt, kind: jsonMode ? 'json' : 'text' },
  })

  if (error) {
    throw new Error(
      error.message ||
        'Função IA indisponível. Faz deploy de `supabase/functions/finance-llm` e define GEMINI_API_KEY ou GROQ_API_KEY nos secrets.',
    )
  }

  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String(data.error))
  }

  const text = data?.text
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Resposta vazia do proxy IA.')
  }
  return text.trim()
}
