import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type Value = {
  contextPack: string
  setFinanceContextPack: (s: string) => void
}

const FinanceAiContext = createContext<Value | null>(null)

export function FinanceAiProvider({ children }: { children: ReactNode }) {
  const [contextPack, setPack] = useState('')

  const setFinanceContextPack = useCallback((s: string) => {
    setPack(s)
  }, [])

  const value = useMemo(
    () => ({ contextPack, setFinanceContextPack }),
    [contextPack, setFinanceContextPack],
  )

  return <FinanceAiContext.Provider value={value}>{children}</FinanceAiContext.Provider>
}

export function useFinanceAiContext(): Value {
  const v = useContext(FinanceAiContext)
  if (!v) {
    throw new Error('useFinanceAiContext must be used within FinanceAiProvider')
  }
  return v
}
