/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_GEMINI_API_KEY?: string
  readonly VITE_GEMINI_MODEL?: string
  readonly VITE_GROQ_API_KEY?: string
  readonly VITE_GROQ_MODEL?: string
  /** groq-first = tenta Groq antes do Gemini (útil se a chave Gemini na Vercel estiver inválida) */
  readonly VITE_FINANCE_LLM_ORDER?: string
  /** true: chama a Edge Function `finance-llm` (secrets na Supabase); não usa VITE_GEMINI no cliente */
  readonly VITE_FINANCE_LLM_VIA_EDGE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
