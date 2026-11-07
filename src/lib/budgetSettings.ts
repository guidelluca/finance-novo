/**
 * Orçamento mensal simples, guardado no localStorage por utilizador + mês.
 * Chave: finance-pwa:budget:<userId>:<YYYY-MM> → cents (number).
 * Também guarda um valor "default" (finance-pwa:budget:<userId>:default) que
 * pré-preenche futuros meses.
 */

const NS = 'finance-pwa:budget'

function monthKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function keyFor(userId: string, date: Date): string {
  return `${NS}:${userId}:${monthKey(date)}`
}

function keyDefault(userId: string): string {
  return `${NS}:${userId}:default`
}

export function getMonthBudgetCents(userId: string, date: Date): number | null {
  try {
    const specific = localStorage.getItem(keyFor(userId, date))
    if (specific != null) {
      const n = Number(specific)
      if (Number.isFinite(n) && n >= 0) return n
    }
    const def = localStorage.getItem(keyDefault(userId))
    if (def != null) {
      const n = Number(def)
      if (Number.isFinite(n) && n >= 0) return n
    }
    return null
  } catch {
    return null
  }
}

export function setMonthBudgetCents(userId: string, date: Date, cents: number | null): void {
  try {
    const k = keyFor(userId, date)
    if (cents == null) {
      localStorage.removeItem(k)
    } else {
      localStorage.setItem(k, String(Math.max(0, Math.round(cents))))
      // Atualiza o default para que o próximo mês herde.
      localStorage.setItem(keyDefault(userId), String(Math.max(0, Math.round(cents))))
    }
  } catch {
    // ignore quota errors
  }
}
