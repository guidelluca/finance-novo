import { CalendarDays, ClipboardCheck, CreditCard, Fingerprint, FolderTree, Home, House, List, LogOut, Moon, PieChart, PiggyBank, Plane, Plus, Settings, Sparkles, Sun, Target, Upload } from 'lucide-react'
import { FloatingAiChat } from '@/components/ai/FloatingAiChat'
import { AppLock } from '@/components/auth/AppLock'
import { PasskeyPrompt } from '@/components/auth/PasskeyPrompt'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme } from '@/contexts/ThemeContext'
import { seedDefaultCategoriesIfEmpty, seedDefaultRulesIfEmpty } from '@/lib/seedCategories'
import { autoCategorizeExisting, ensureFoodTree } from '@/lib/categorize'
import { cn } from '@/lib/utils'

type NavItem = { to: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; label: string }

/** Barra de baixo (design Lima): o item /import vira o botão "+" central. */
const primaryNav: NavItem[] = [
  { to: '/', icon: Home, label: 'Início' },
  { to: '/transactions', icon: List, label: 'Extrato' },
  { to: '/import', icon: Upload, label: 'Adicionar' },
  { to: '/orcamento', icon: PieChart, label: 'Orçamento' },
  { to: '/metas', icon: Target, label: 'Metas' },
]

/** Menu do avatar (topo) */
const secondaryNav: NavItem[] = [
  { to: '/fechamento', icon: ClipboardCheck, label: 'Fechamento do mês' },
  { to: '/casa', icon: House, label: 'Casa (república)' },
  { to: '/viagens', icon: Plane, label: 'Viagens' },
  { to: '/mes', icon: CalendarDays, label: 'Mês consolidado' },
  { to: '/cards', icon: CreditCard, label: 'Cartões' },
  { to: '/analysis', icon: Sparkles, label: 'Análise IA' },
  { to: '/savings', icon: PiggyBank, label: 'Poupança' },
  { to: '/categories', icon: FolderTree, label: 'Categorias' },
  { to: '/rules', icon: Settings, label: 'Regras' },
  { to: '/seguranca', icon: Fingerprint, label: 'Segurança' },
]

export function AppShell() {
  const { user, signOut } = useAuth()
  const { resolved, toggle } = useTheme()
  const [moreOpen, setMoreOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    if (!user) return
    void (async () => {
      try {
        await seedDefaultCategoriesIfEmpty(user.id)
        await seedDefaultRulesIfEmpty(user.id)
        // uma vez: Alimentação com subcategorias + categoriza o que está sem categoria / reorganiza comida
        if (await ensureFoodTree(user)) {
          const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
          const r = await autoCategorizeExisting(user.id, since)
          if (r.filled || r.moved) window.dispatchEvent(new CustomEvent('finance:recategorized', { detail: r }))
        }
      } catch (e) {
        console.error(e)
      }
    })()
  }, [user])

  const isSecondaryActive = secondaryNav.some((it) => location.pathname === it.to)
  const closeMore = () => setMoreOpen(false)

  return (
    <div className="flex min-h-dvh flex-col bg-background pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-40 flex items-center justify-end gap-2 bg-background/90 px-4 py-2 backdrop-blur-md pt-[max(0.5rem,env(safe-area-inset-top))]">
        <span className="mr-auto flex items-center gap-2 font-display text-lg font-bold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-lg bg-ink text-sm text-lime" aria-hidden>
            F
          </span>
          Finance
        </span>
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          aria-label="Menu e ajustes"
          className={cn(
            'flex size-11 items-center justify-center rounded-[14px] bg-ink font-display text-base font-bold text-lime transition',
            (moreOpen || isSecondaryActive) && 'ring-2 ring-lime ring-offset-2 ring-offset-background',
          )}
        >
          {(user?.email ?? 'F').charAt(0).toUpperCase()}
        </button>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pt-4">
        <AppLock />
        <PasskeyPrompt />
        <Outlet />
      </main>

      {moreOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={() => setMoreOpen(false)}
            aria-label="Fechar menu"
          />
          <div
            className="fixed inset-x-0 top-[calc(4rem+env(safe-area-inset-top))] z-50 mx-auto max-w-lg px-3"
            role="dialog"
            aria-modal="true"
          >
            <div className="animate-[fadeUp_150ms_ease-out] overflow-hidden rounded-3xl border border-border bg-surface shadow-xl">
              <ul className="grid grid-cols-2 gap-1 p-2">
                {secondaryNav.map(({ to, icon: Icon, label }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      onClick={closeMore}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-sm font-medium transition',
                          isActive
                            ? 'bg-lime text-ink'
                            : 'text-foreground/80 hover:bg-background',
                        )
                      }
                    >
                      <Icon className="size-4" strokeWidth={1.75} />
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
              <div className="border-t border-border p-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    closeMore()
                    window.dispatchEvent(new Event('finance:open-ai'))
                  }}
                >
                  <Sparkles className="size-4" />
                  Perguntar à IA sobre seus gastos
                </Button>
              </div>
              <div className="flex gap-2 border-t border-border p-2">
                <Button type="button" variant="ghost" className="flex-1 justify-start" onClick={toggle}>
                  {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  {resolved === 'dark' ? 'Modo claro' : 'Modo escuro'}
                </Button>
                <Button type="button" variant="ghost" className="flex-1 justify-start text-danger" onClick={() => void signOut()}>
                  <LogOut className="size-4" />
                  Sair
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <nav
        className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
        aria-label="Principal"
      >
        <ul className="mx-auto flex max-w-lg items-start justify-between gap-0.5 px-1 pb-1 pt-2">
          {primaryNav.map(({ to, icon: Icon, label }) =>
            to === '/import' ? (
              <li key={to} className="flex min-w-0 flex-1 justify-center">
                <NavLink
                  to={to}
                  aria-label="Adicionar ou importar"
                  className={({ isActive }) =>
                    cn(
                      '-mt-4 flex size-14 items-center justify-center rounded-[20px] shadow-lg transition-transform active:scale-95',
                      isActive ? 'bg-lime text-ink' : 'bg-ink text-lime',
                    )
                  }
                >
                  <Plus className="size-6" strokeWidth={2.2} />
                </NavLink>
              </li>
            ) : (
              <li key={to} className="min-w-0 flex-1">
                <NavLink
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'group flex min-w-0 flex-col items-center gap-1 py-0.5 text-[11px] font-medium leading-tight text-muted transition-colors',
                      isActive && 'font-semibold text-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={cn(
                          'flex h-[30px] w-[52px] items-center justify-center rounded-full transition-colors',
                          isActive && 'bg-lime text-ink',
                        )}
                      >
                        <Icon className="size-5" strokeWidth={1.8} />
                      </span>
                      {label}
                    </>
                  )}
                </NavLink>
              </li>
            ),
          )}
        </ul>
      </nav>
      <FloatingAiChat />
    </div>
  )
}
