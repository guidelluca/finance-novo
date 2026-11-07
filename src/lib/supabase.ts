import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && key)

// Passkeys (Face ID / Touch ID) são beta no Supabase Auth: exigem opt-in explícito.
const options = { auth: { experimental: { passkey: true } } } as unknown as SupabaseClientOptions<'public'>

const client: SupabaseClient<Database> | null = isSupabaseConfigured
  ? createClient<Database>(url!, key!, options)
  : null

export const supabase = client as SupabaseClient<Database>
