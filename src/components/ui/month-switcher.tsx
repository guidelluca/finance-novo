import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** Barra de troca de mês igual em todas as telas: "Novembro de 2026 · 29/10–26/11". */
export function MonthSwitcher({
  month,
  range,
  onChange,
}: {
  month: string
  range?: { start: string; end: string }
  onChange: (delta: -1 | 1) => void
}) {
  const label = format(parseISO(`${month}-01`), "LLLL 'de' yyyy", { locale: ptBR })
  const d = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border bg-surface px-1">
      <button type="button" aria-label="Mês anterior" onClick={() => onChange(-1)} className="flex size-11 items-center justify-center text-muted">
        <ChevronLeft className="size-5" />
      </button>
      <span className="text-center">
        <span className="block text-sm font-semibold first-letter:uppercase">{label}</span>
        {range ? (
          <span className="block text-xs text-muted">
            {d(range.start)} a {d(range.end)}
          </span>
        ) : null}
      </span>
      <button type="button" aria-label="Próximo mês" onClick={() => onChange(1)} className="flex size-11 items-center justify-center text-muted">
        <ChevronRight className="size-5" />
      </button>
    </div>
  )
}
