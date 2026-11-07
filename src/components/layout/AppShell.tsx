import {
  CalendarDays,
  Fingerprint,
  CreditCard,
  FolderTree,
  Home,
  List,
  LogOut,
  MoreHorizontal,
  Plus,
  Moon,
  PiggyBank,
  Settings,
  Sparkles,
  Sun,
  Upload,
} from 'lucide-react'
import { FloatingAiChat } from '@/components/ai/FloatingAiChat'
import { PasskeyPrompt } from '@/components/auth/PasskeyPrompt'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme } from '@/contexts/ThemeContext'
import { seedDefaultCategoriesIfEmpty, seedDefaultRulesIfEmpty } from '@/lib/seedCategories'
import { cn } from '@/lib/utils'

type NavItem = { to: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; label: string }

/** Barra de baixo (design Lima): o item /import vira o botão "+" central. */
const primaryNav: NavItem[] = [
  { to: '/', icon: Home, label: 'Início' },
  { to: '/mes', icon: CalendarDays, label: 'Mês' },
  { to: '/import', icon: Upload, label: 'Adicionar' },
  { to: '/transactions', icon: List, label: 'Extrato' },
]

const secondaryNav: NavItem[] = [
  { to: '/cards', icon: CreditCard, label: 'Cartões' },
  { to: '/analysis', icon: Sparkles, label: 'Análise' },
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted"
          onClick={toggle}
          aria-label={resolved === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
          title={resolved === 'dark' ? 'Modo claro' : 'Modo escuro'}
        >
          {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted"
          onClick={() => void signOut()}
        >
          <LogOut className="size-4" />
          Sair
        </Button>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pt-4">
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
            className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-lg px-3 pb-2"
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
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              className={cn(
                'flex w-full min-w-0 flex-col items-center gap-1 py-0.5 text-[11px] font-medium leading-tight text-muted transition-colors',
                (moreOpen || isSecondaryActive) && 'font-semibold text-foreground',
              )}
              aria-expanded={moreOpen}
              aria-label="Mais opções"
            >
              <span
                className={cn(
                  'flex h-[30px] w-[52px] items-center justify-center rounded-full transition-colors',
                  (moreOpen || isSecondaryActive) && 'bg-lime text-ink',
                )}
              >
                <MoreHorizontal className="size-5" strokeWidth={1.8} />
              </span>
              Mais
            </button>
          </li>
        </ul>
      </nav>
      <FloatingAiChat />
    </div>
  )
}
