import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import type { Category, Rule } from '@/types/database'

export function RulesPage() {
  const { user } = useAuth()
  const [rules, setRules] = useState<Rule[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [form, setForm] = useState({
    match_type: 'contains' as Rule['match_type'],
    pattern: '',
    category_id: '',
    priority: '10',
  })

  const load = useCallback(() => {
    if (!user) return
    void (async () => {
      const { data: r } = await supabase
        .from('rules')
        .select('*')
        .eq('user_id', user.id)
        .order('priority', { ascending: false })
      setRules(r ?? [])
      const { data: c } = await supabase.from('categories').select('*').eq('user_id', user.id)
      setCategories(c ?? [])
    })()
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !form.category_id || !form.pattern.trim()) return
    await supabase.from('rules').insert({
      user_id: user.id,
      match_type: form.match_type,
      pattern: form.pattern.trim(),
      category_id: form.category_id,
      priority: Number(form.priority) || 0,
      enabled: true,
    })
    setForm((f) => ({ ...f, pattern: '' }))
    load()
  }

  const toggle = async (r: Rule) => {
    await supabase.from('rules').update({ enabled: !r.enabled }).eq('id', r.id)
    load()
  }

  const del = async (id: string) => {
    await supabase.from('rules').delete().eq('id', id)
    load()
  }

  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? id

  return (
    <div className="space-y-6 pb-24">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Regras</h1>
        <p className="text-sm text-muted">
          Palavras ou expressões na descrição do lançamento definem a categoria sugerida (import e
          extrato). Contas novas recebem regras iniciais (Uber, Mercado, restaurante, etc.); pode
          editar, apagar ou acrescentar aqui.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nova regra</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Tipo</Label>
                <select
                  className="mt-1 flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                  value={form.match_type}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      match_type: e.target.value as Rule['match_type'],
                    }))
                  }
                >
                  <option value="contains">Contém</option>
                  <option value="equals">Igual a</option>
                  <option value="regex">Regex</option>
                </select>
              </div>
              <div>
                <Label>Prioridade</Label>
                <Input
                  inputMode="numeric"
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Padrão</Label>
              <Input
                value={form.pattern}
                onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
                placeholder="uber"
                required
              />
            </div>
            <div>
              <Label>Categoria</Label>
              <select
                className="mt-1 flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                value={form.category_id}
                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}
                required
              >
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit">Salvar regra</Button>
          </form>
        </CardContent>
      </Card>

      <ul className="space-y-2">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-elevated/70 px-3 py-2 text-sm"
          >
            <div>
              <span className="font-mono text-xs text-muted">{r.match_type}</span>{' '}
              <span className="font-medium">{r.pattern}</span>
              <span className="text-muted"> → </span>
              <span>{catName(r.category_id)}</span>
              <span className="text-xs text-muted"> · p{r.priority}</span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => toggle(r)}>
                {r.enabled ? 'Off' : 'On'}
              </Button>
              <Button type="button" variant="danger" size="sm" onClick={() => del(r.id)}>
                Excluir
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {rules.length === 0 ? <p className="text-center text-sm text-muted">Nenhuma regra.</p> : null}
    </div>
  )
}
