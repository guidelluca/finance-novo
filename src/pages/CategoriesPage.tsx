import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import type { Category } from '@/types/database'

export function CategoriesPage() {
  const { user } = useAuth()
  const [list, setList] = useState<Category[]>([])
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<string>('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(() => {
    if (!user) return
    void (async () => {
      const { data } = await supabase
        .from('categories')
        .select('*')
        .eq('user_id', user.id)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
      setList(data ?? [])
    })()
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const sorted = useMemo(
    () =>
      [...list].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'pt-BR'),
      ),
    [list],
  )

  const roots = useMemo(() => list.filter((c) => !c.parent_id), [list])
  const childrenOf = (id: string) => list.filter((c) => c.parent_id === id)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !name.trim()) return
    const nextOrder =
      list.length > 0 ? Math.max(...list.map((c) => c.sort_order), -1) + 1 : 0
    await supabase.from('categories').insert({
      user_id: user.id,
      name: name.trim(),
      parent_id: parentId || null,
      sort_order: nextOrder,
    })
    setName('')
    setParentId('')
    load()
  }

  const saveRename = async () => {
    if (!user || !editing || !editing.name.trim()) return
    await supabase.from('categories').update({ name: editing.name.trim() }).eq('id', editing.id)
    setEditing(null)
    load()
  }

  const remove = async (id: string) => {
    await supabase.from('categories').delete().eq('id', id)
    setEditing((e) => (e?.id === id ? null : e))
    load()
  }

  return (
    <div className="space-y-6 pb-24">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Categorias</h1>
        <p className="text-sm text-muted">
          Lista criada automaticamente na primeira vez; pode editar, excluir ou criar novas. A
          classificação automática usa as regras em <strong>Regras</strong>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nova categoria</CardTitle>
          <CardDescription>Opcional: torne subcategoria escolhendo um pai.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <Label>Subcategoria de (opcional)</Label>
              <select
                className="mt-1 flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">— Raiz —</option>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parent_id ? `↳ ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit">Adicionar</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Suas categorias</CardTitle>
          <CardDescription>
            {roots.some((r) => childrenOf(r.id).length > 0)
              ? 'Árvore (raiz e filhos).'
              : 'Lista plana — use Editar para mudar o nome.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {sorted.map((c) => {
            const indent = c.parent_id ? 'pl-6 border-l border-border' : ''
            return (
              <div
                key={c.id}
                className={`flex flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-surface-elevated/60 px-3 py-2 ${indent}`}
              >
                {editing?.id === c.id ? (
                  <>
                    <Input
                      className="min-w-[10rem] flex-1"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      autoFocus
                    />
                    <Button type="button" size="sm" onClick={() => void saveRename()}>
                      Salvar
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 font-medium">{c.name}</span>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditing({ id: c.id, name: c.name })}>
                      Editar
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void remove(c.id)}>
                      Excluir
                    </Button>
                  </>
                )}
              </div>
            )
          })}
          {sorted.length === 0 ? <p className="text-sm text-muted">Nenhuma categoria ainda.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
