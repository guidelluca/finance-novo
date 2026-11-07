import { MessageCircle, Send, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useFinanceAiContext } from '@/contexts/FinanceAiContext'
import { fetchFinanceAiLiveSnapshot } from '@/lib/financeAiSnapshot'
import { financeLlmGenerateText, isFinanceLlmConfigured } from '@/lib/financeLlm'
import { cn } from '@/lib/utils'

type Msg = { role: 'user' | 'assistant'; content: string }

function buildChatPrompt(history: Msg[], staticContext: string, liveSnapshot: string): string {
  const sys = [
    'És um assistente de finanças pessoais. Responde em português do Brasil, de forma clara e prática (usa listas quando ajudar).',
    'Usa APENAS os números e categorias que aparecem no contexto abaixo; não inventes valores. Se algo faltar, diz o que falta e sugere importar/atualizar o extrato.',
    'Podes: comparar categorias e meses, apontar onde o utilizador parece gastar mais (com base nas linhas de maiores débitos e nos totais por categoria), sugerir metas de poupança realistas (ex.: % da renda, fundo de emergência em meses de despesas médias) e estratégias genéricas de corte (substituir gastos, pausar assinaturas, orçamento por envelope).',
    'Não dês aconselhamento jurídico nem recomendações específicas de investimento (ações, cripto, produtos financeiros nomeados); mantém hábitos, orçamento e reserva de segurança.',
  ].join('\n')

  const staticBlock = staticContext.trim()
    ? `Resumo agregado (ao navegar em Início/Análise; centavos = 1/100 de real):\n${staticContext}\n`
    : 'Ainda não há resumo agregado carregado — convém abrir Início ou Análise uma vez nesta sessão.\n'

  const liveBlock = liveSnapshot.trim()
    ? `---\nDados reais atualizados AGORA (últimos 90 dias, para esta mensagem):\n${liveSnapshot}\n`
    : ''

  const conv = history
    .map((m) => (m.role === 'user' ? `Utilizador: ${m.content}` : `Assistente: ${m.content}`))
    .join('\n')

  return `${sys}\n${staticBlock}${liveBlock}\nConversa:\n${conv}\nAssistente (responde só à última mensagem do utilizador, sem repetir o prefixo "Assistente:"):`
}

export function FloatingAiChat() {
  const { user } = useAuth()
  const { contextPack } = useFinanceAiContext()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  useEffect(() => {
    if (open) scrollDown()
  }, [open, messages, loading, scrollDown])

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!isFinanceLlmConfigured()) {
      setError(
        'IA: no deploy, define VITE_GEMINI_API_KEY ou VITE_GROQ_API_KEY nas variáveis de ambiente de Production e faz Redeploy; ou usa VITE_FINANCE_LLM_VIA_EDGE=true com a função Supabase finance-llm (ver .env.example).',
      )
      return
    }
    setError(null)
    setInput('')
    const nextHistory: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(nextHistory)
    setLoading(true)
    try {
      const live =
        user?.id != null ? await fetchFinanceAiLiveSnapshot(user.id).catch(() => '') : ''
      const prompt = buildChatPrompt(nextHistory, contextPack, live)
      const reply = await financeLlmGenerateText(prompt)
      setMessages([...nextHistory, { role: 'assistant', content: reply }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro ao responder.'
      setError(msg)
      setMessages([...nextHistory, { role: 'assistant', content: `Não consegui responder: ${msg}` }])
    } finally {
      setLoading(false)
    }
  }

  const bottomOffset = 'calc(5.25rem + env(safe-area-inset-bottom, 0px))'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'fixed z-[60] flex size-14 items-center justify-center rounded-full border border-border bg-accent text-[#04120c] shadow-[var(--shadow-card)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          open && 'pointer-events-none opacity-0',
        )}
        style={{ right: 'max(1rem, env(safe-area-inset-right))', bottom: bottomOffset }}
        aria-label="Abrir assistente de finanças"
      >
        <MessageCircle className="size-7 opacity-95" strokeWidth={2} />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[61] flex flex-col justify-end bg-black/45 backdrop-blur-[1px] sm:items-end sm:justify-end sm:bg-black/35 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-chat-title"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-[var(--shadow-card)] sm:mb-4 sm:max-h-[min(32rem,82dvh)] sm:w-full sm:max-w-md sm:rounded-2xl"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <h2 id="ai-chat-title" className="text-base font-semibold">
                  Assistente
                </h2>
                <p className="text-xs text-muted">
                  Usa o teu extrato (resumo + últimos 90 dias atualizados em cada mensagem)
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Link
                  to="/analysis"
                  className="rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:underline"
                  onClick={() => setOpen(false)}
                >
                  Análise
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-lg"
                  onClick={() => setOpen(false)}
                  aria-label="Fechar chat"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {messages.length === 0 ? (
                <p className="text-sm text-muted">
                  Pergunta onde estás a gastar mais, quanto podes poupar, ou estratégias para cortar custos.
                  Abre Início ou Análise uma vez para carregar o resumo mensal; em cada resposta usamos também os
                  teus lançamentos recentes.
                </p>
              ) : (
                messages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      'max-w-[95%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'ml-auto bg-accent/20 text-foreground'
                        : 'mr-auto border border-border/80 bg-surface-elevated/60 text-foreground/95',
                    )}
                  >
                    {m.content}
                  </div>
                ))
              )}
              {loading ? (
                <p className="text-xs text-muted" aria-live="polite">
                  A pensar…
                </p>
              ) : null}
              {error && messages.length === 0 ? <p className="text-sm text-danger">{error}</p> : null}
            </div>

            <div className="border-t border-border p-3">
              <div className="flex gap-2">
                <textarea
                  className="min-h-[44px] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  placeholder="Escreve a tua pergunta…"
                  rows={2}
                  value={input}
                  maxLength={4000}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  disabled={loading}
                />
                <Button
                  type="button"
                  size="icon"
                  className="shrink-0 self-end rounded-xl"
                  disabled={loading || !input.trim()}
                  onClick={() => void send()}
                  aria-label="Enviar"
                >
                  <Send className="size-4" />
                </Button>
              </div>
              <button
                type="button"
                className="mt-2 text-xs text-muted hover:text-foreground"
                onClick={() => {
                  setMessages([])
                  setError(null)
                }}
              >
                Limpar conversa
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
