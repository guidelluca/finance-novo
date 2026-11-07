# Publicar no iPhone (Vercel + HTTPS)

## 1. GitHub

```bash
cd finance-pwa
git remote add origin https://github.com/guideluca/finance-pwa.git
git branch -M main
git push -u origin main
```

Crie antes, no GitHub (utilizador **guideluca**), um repositório vazio chamado **finance-pwa**:
https://github.com/new — nome: `finance-pwa`, sem README (o teu projeto já tem ficheiros).

Se `git remote add` disser que `origin` já existe: `git remote set-url origin https://github.com/guideluca/finance-pwa.git`

**Base de dados:** no Supabase → SQL Editor, execute também ficheiros novos em `supabase/migrations/` que ainda não tenha corrido (ex. `*_transaction_dedup.sql` para deduplicação).

## 2. Vercel

1. Aceda a [vercel.com](https://vercel.com) e inicie sessão (ex. com GitHub).
2. **Add New… → Project** → importe o repositório `finance-pwa`.
3. Deixe **Framework Preset: Vite** (ou confirme build `npm run build`, output `dist`).
4. Em **Environment Variables**, adicione:

   - `VITE_SUPABASE_URL` = URL do projeto (Supabase → Settings → API)
   - `VITE_SUPABASE_ANON_KEY` = chave **publishable** (não use `service_role`)

5. **Deploy**. Guarde o URL final (ex. `https://finance-pwa-xxx.vercel.app`).

## 3. Supabase (login no domínio público)

No dashboard Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** o URL da Vercel (ex. `https://finance-pwa-xxx.vercel.app`)
- **Redirect URLs:** acrescente o mesmo URL (e `https://finance-pwa-xxx.vercel.app/**` se o painel permitir)

## 4. iPhone

Safari → abra o URL da Vercel → Partilhar → **Adicionar ao ecrã principal**.

---

O ficheiro `vercel.json` já força o roteamento da SPA (React Router) e o build Vite.
