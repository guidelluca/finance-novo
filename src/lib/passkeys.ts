/**
 * Login com passkey (WebAuthn): Face ID no iPhone, Touch ID no Mac, digital no Android, Windows Hello.
 * Usa as Passkeys do Supabase Auth (beta, supabase-js ≥ 2.105 com `experimental.passkey`).
 * O Supabase guarda só a chave pública; a chave privada fica no aparelho / iCloud Keychain.
 */
import { supabase } from '@/lib/supabase'

type Result<T> = Promise<{ data: T; error: { message: string; code?: string; name?: string } | null }>
export type PasskeyInfo = { id: string; friendly_name?: string | null; created_at: string; last_used_at?: string | null }

/** API experimental: tipada aqui para não depender da versão exata dos tipos do SDK */
type PasskeyAuth = {
  registerPasskey: () => Result<PasskeyInfo | null>
  signInWithPasskey: () => Result<{ session: unknown; user: unknown } | null>
  passkey: {
    list: () => Result<PasskeyInfo[] | null>
    update: (p: { passkeyId: string; friendlyName: string }) => Result<unknown>
    delete: (p: { passkeyId: string }) => Result<unknown>
  }
}
const auth = () => supabase.auth as unknown as PasskeyAuth

const ENROLLED_KEY = 'finance:passkey-enrolled'
const DISMISSED_KEY = 'finance:passkey-dismissed'

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function storageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* sem armazenamento */
  }
}

export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function'
}

/** Este aparelho tem Face ID / Touch ID / digital disponível? */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!passkeySupported()) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/** Nome amigável do método neste aparelho */
export function biometricLabel(): string {
  const ua = navigator.userAgent
  const touch = navigator.maxTouchPoints > 1
  if (/iPhone|iPod/.test(ua)) return 'Face ID'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'Face ID / Touch ID'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Touch ID'
  if (/Android/.test(ua)) return 'digital'
  if (/Windows/.test(ua)) return 'Windows Hello'
  return 'biometria'
}

function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Macintosh/.test(ua)) return 'MacBook'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Aparelho'
}

export function friendlyPasskeyError(e: { message?: string; code?: string; name?: string } | null | undefined): string {
  const code = e?.code ?? ''
  const name = e?.name ?? ''
  const msg = e?.message ?? ''
  if (name === 'NotAllowedError' || /not allowed|cancel|aborted|timed out/i.test(msg))
    return 'Cancelado ou expirou. Tente de novo.'
  if (code === 'passkey_disabled')
    return 'Login com passkey ainda não está ativado no Supabase (Authentication → Passkeys).'
  if (code === 'webauthn_credential_not_found')
    return 'Este aparelho não tem passkey cadastrada. Entre com e-mail e senha e ative em Segurança.'
  if (code === 'webauthn_credential_exists') return 'Este aparelho já está cadastrado.'
  if (code === 'too_many_passkeys') return 'Limite de passkeys atingido. Remova uma em Segurança.'
  if (code === 'webauthn_challenge_expired' || code === 'webauthn_challenge_not_found')
    return 'O pedido expirou. Tente de novo.'
  if (name === 'SecurityError' || /rp ?id|origin/i.test(msg))
    return 'Endereço não autorizado para passkey. Confira o Relying Party ID e as Origins no Supabase.'
  return msg || 'Não foi possível usar a passkey.'
}

export async function signInWithPasskey(): Promise<string | null> {
  const { error } = await auth().signInWithPasskey()
  if (error) return friendlyPasskeyError(error)
  storageSet(ENROLLED_KEY, '1')
  return null
}

export async function registerPasskeyOnThisDevice(): Promise<{ error: string | null }> {
  const { data, error } = await auth().registerPasskey()
  if (error) {
    if (error.code === 'webauthn_credential_exists') storageSet(ENROLLED_KEY, '1')
    return { error: friendlyPasskeyError(error) }
  }
  storageSet(ENROLLED_KEY, '1')
  if (data?.id) {
    const when = new Date().toLocaleDateString('pt-BR')
    await auth().passkey.update({ passkeyId: data.id, friendlyName: `${deviceName()} · ${biometricLabel()} · ${when}` })
  }
  return { error: null }
}

export async function listPasskeys(): Promise<{ data: PasskeyInfo[]; error: string | null }> {
  const { data, error } = await auth().passkey.list()
  return { data: data ?? [], error: error ? friendlyPasskeyError(error) : null }
}

export async function deletePasskey(id: string): Promise<string | null> {
  const { error } = await auth().passkey.delete({ passkeyId: id })
  return error ? friendlyPasskeyError(error) : null
}

export function isEnrolledHere(): boolean {
  return storageGet(ENROLLED_KEY) === '1'
}
export function forgetEnrolledHere() {
  try {
    localStorage.removeItem(ENROLLED_KEY)
  } catch {
    /* ignora */
  }
}
export function promptDismissed(): boolean {
  return storageGet(DISMISSED_KEY) === '1'
}
export function dismissPrompt() {
  storageSet(DISMISSED_KEY, '1')
}
