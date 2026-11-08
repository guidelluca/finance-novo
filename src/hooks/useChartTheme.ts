import { useTheme } from '@/contexts/ThemeContext'

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
  // segue o tema escolhido no app (claro/escuro), não só o do sistema
  const isDark = useTheme().resolved === 'dark'

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
