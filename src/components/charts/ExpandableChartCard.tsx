import { Maximize2 } from 'lucide-react'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type ChartSize = 'sm' | 'md' | 'lg'

const heightClass: Record<ChartSize, string> = {
  sm: 'h-56 md:h-64',
  md: 'h-64 md:h-72',
  lg: 'h-72 md:h-80',
}

type Props = {
  title: string
  subtitle?: string | React.ReactNode
  size?: ChartSize
  /** Unique prefix for SVG gradient IDs (avoids clashes when compact + expanded both mount). */
  svgIdPrefix: string
  dialogClassName?: string
  renderChart: (idSuffix: string, opts: { tall: boolean }) => React.ReactNode
}

/** Renders `renderChart` twice: in-card and in a large dialog. Pass distinct gradient IDs using `svgIdPrefix` + suffix. */
export function ExpandableChartCard({
  title,
  subtitle,
  size = 'md',
  svgIdPrefix,
  dialogClassName,
  renderChart,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const compactSuffix = `${svgIdPrefix}-c`
  const dialogSuffix = `${svgIdPrefix}-d`

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base leading-snug">{title}</CardTitle>
          {subtitle ? (
            typeof subtitle === 'string' ? (
              <p className="text-xs text-muted">{subtitle}</p>
            ) : (
              subtitle
            )
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-xl"
          onClick={() => setOpen(true)}
          aria-label={`Expandir gráfico: ${title}`}
        >
          <Maximize2 />
        </Button>
      </CardHeader>
      <CardContent className={cn(heightClass[size], 'pt-0')}>{renderChart(compactSuffix, { tall: false })}</CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            'max-h-[92dvh] max-w-[min(96vw,56rem)] overflow-y-auto p-4 sm:p-6',
            dialogClassName,
          )}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {typeof subtitle === 'string' ? (
              <DialogDescription>{subtitle}</DialogDescription>
            ) : subtitle ? (
              <div className="text-sm text-muted">{subtitle}</div>
            ) : null}
          </DialogHeader>
          <div className="min-h-[min(72dvh,36rem)] w-full pt-2">{renderChart(dialogSuffix, { tall: true })}</div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
