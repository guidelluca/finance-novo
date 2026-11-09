import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { FinanceAiProvider } from '@/contexts/FinanceAiContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { isSupabaseConfigured } from '@/lib/supabase'
import { CardsPage } from '@/pages/CardsPage'
import { CategoriesPage } from '@/pages/CategoriesPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { FinanceAnalysisPage } from '@/pages/FinanceAnalysisPage'
import { ImportPage } from '@/pages/ImportPage'
import { LoginPage } from '@/pages/LoginPage'
import { MonthPage } from '@/pages/MonthPage'
import { FechamentoPage } from '@/pages/FechamentoPage'
import { CasaPage } from '@/pages/CasaPage'
import { HomePage } from '@/pages/HomePage'
import { BudgetPage } from '@/pages/BudgetPage'
import { GoalsPage } from '@/pages/GoalsPage'
import { SecurityPage } from '@/pages/SecurityPage'
import { RulesPage } from '@/pages/RulesPage'
import { SavingsPage } from '@/pages/SavingsPage'
import { SetupPage } from '@/pages/SetupPage'
import { TransactionsPage } from '@/pages/TransactionsPage'
import { ExtratoPage } from '@/pages/ExtratoPage'

function RequireSupabase() {
  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />
  return <Outlet />
}

function RequireAuth() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-muted">
        Carregando…
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireSupabase />}>
        <Route element={<RequireAuth />}>
          <Route
            element={
              <FinanceAiProvider>
                <AppShell />
              </FinanceAiProvider>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="historico" element={<DashboardPage />} />
            <Route path="orcamento" element={<BudgetPage />} />
            <Route path="metas" element={<GoalsPage />} />
            <Route path="mes" element={<MonthPage />} />
            <Route path="fechamento" element={<FechamentoPage />} />
            <Route path="casa" element={<CasaPage />} />
            <Route path="seguranca" element={<SecurityPage />} />
            <Route path="analysis" element={<FinanceAnalysisPage />} />
            <Route path="cards" element={<CardsPage />} />
            <Route path="savings" element={<SavingsPage />} />
            <Route path="transactions" element={<ExtratoPage />} />
            <Route path="transactions/avancado" element={<TransactionsPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="rules" element={<RulesPage />} />
          </Route>
        </Route>
      </Route>
      <Route
        path="*"
        element={<Navigate to={isSupabaseConfigured ? '/' : '/setup'} replace />}
      />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
      <ThemeProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
