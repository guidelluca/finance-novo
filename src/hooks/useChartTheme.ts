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
      grid: '#2b2e34',
      axis: '#a0a5ac',
      tooltipBg: '#17191c',
      tooltipBorder: '#2b2e34',
      tooltipColor: '#eef0ea',
      emerald: '#c8f169',
      red: '#f28c6b',
      accentSoft: 'rgba(200, 241, 105, 0.22)',
    }
  }
  return {
    isDark: false,
    grid: '#e2e4dc',
    axis: '#5e636b',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e2e4dc',
    tooltipColor: '#14161a',
    emerald: '#14161a',
    red: '#c2410c',
    accentSoft: 'rgba(200, 241, 105, 0.45)',
  }
}
