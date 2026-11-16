import { Ban, CircleCheck, Lightbulb, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { aiReady, askAiAdvice, readAiAdvice, ruleAdvice, type AdviceInput, type AiAdvice } from '@/lib/spendingAdvice'
import { cn } from '@/lib/utils'

const BR = (r: number) => r.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
const ICON = { pode: CircleCheck, evitar: Ban, dica: Lightbulb }
const TONE = { pode: 'text-[#3f5a12] dark:text-[#c8f169]', evitar: 'text-danger', dica: 'text-muted' }

/** Conselhos do mês: regras com os seus números + (se configurada) uma análise da IA. */
export function AdvicePanel({ input, cacheKey, title = 'O que pode e o que evitar' }: { input: AdviceInput | null; cacheKey: string; title?: string }) {
  const rules = useMemo(() => (input ? ruleAdvice(input) : []), [input])
  const [ai, setAi] = useState<{ at: string; data: AiAdvice } | null>(() => readAiAdvice(cacheKey))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ready = aiReady()

  const run = async () => {
    if (!input) return
    setBusy(true)
    setErr(null)
    try {
      const data = await askAiAdvice(cacheKey, input)
      setAi({ at: new Date().toISOString(), data })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!input) return null
  return (
    <section className="rise space-y-3 rounded-3xl border border-border bg-surface p-4" aria-label={title}>
      <header className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-xl bg-background">
          <Sparkles className="size-3.5 text-muted" />
        </span>
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
      </header>
      <ul className="space-y-2">
        {rules.map((r, i) => {
          const Icon = ICON[r.kind]
          return (
            <li key={i} className="flex gap-2.5 text-sm">
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[r.kind])} />
              <div className="min-w-0">
                <p className="font-medium">{r.title}</p>
                <p className="text-xs text-muted">{r.detail}</p>
              </div>
            </li>
          )
        })}
      </ul>

      {ai ? (
        <div className="space-y-2.5 rounded-2xl bg-background p-3 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Sparkles className="size-3.5" /> Análise da IA · {new Date(ai.at).toLocaleDateString('pt-BR')}
          </p>
          {ai.data.pode_gastar?.length ? (
            <div>
              <p className="text-xs font-semibold text-[#3f5a12] dark:text-[#c8f169]">Pode gastar</p>
              <ul className="mt-0.5 space-y-0.5 text-xs">
                {ai.data.pode_gastar.map((x, i) => (
                  <li key={i}>
                    <b>{x.item}</b>
                    {x.valor_reais != null ? ` · até ${BR(x.valor_reais)}` : ''} — <span className="text-muted">{x.motivo}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {ai.data.evitar?.length ? (
            <div>
              <p className="text-xs font-semibold text-danger">Evitar ou cortar</p>
              <ul className="mt-0.5 space-y-0.5 text-xs">
                {ai.data.evitar.map((x, i) => (
                  <li key={i}>
                    <b>{x.item}</b>
                    {x.economia_reais != null ? ` · economia ~${BR(x.economia_reais)}/mês` : ''} — <span className="text-muted">{x.motivo}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {ai.data.dicas?.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
              {ai.data.dicas.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {ready ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run()}>
          <Sparkles className="size-4" />
          {busy ? 'Pensando…' : ai ? 'Atualizar análise da IA' : 'Pedir conselhos à IA'}
        </Button>
      ) : (
        <p className="text-[11px] text-muted">
          A análise com IA fica disponível quando uma chave de IA (Gemini ou Groq) estiver configurada no app. Os conselhos acima já usam os seus números.
        </p>
      )}
      {err ? <p className="text-xs text-danger">{err}</p> : null}
      <p className="text-[11px] text-muted">Referências gerais de educação financeira, não recomendação profissional.</p>
    </section>
  )
}
