import { useEffect, useState } from 'react'

export type ChartTheme = {
  isDark: boolean
  grid: string
  axis: string
  tooltipBg: string
  tooltipBorder: string
  tooltipColor: string
  emerald: string
  red: string
  accentSoft: string
}

export function useChartTheme(): ChartTheme {
  const [isDark, setIsDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setIsDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (isDark) {
    return {
      isDark: true,
      grid: '#243044',
      axis: '#8b9cb5',
      tooltipBg: '#111827',
      tooltipBorder: '#243044',
      tooltipColor: '#e8edf5',
      emerald: '#34d399',
      red: '#f87171',
      accentSoft: 'rgba(52, 211, 153, 0.25)',
    }
  }
  return {
    isDark: false,
    grid: '#e2e8f0',
    axis: '#64748b',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e2e8f0',
    tooltipColor: '#0f172a',
    emerald: '#059669',
    red: '#dc2626',
    accentSoft: 'rgba(5, 150, 105, 0.15)',
  }
}
