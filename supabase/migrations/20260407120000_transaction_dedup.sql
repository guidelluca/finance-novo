-- Dedup: evita a mesma transação (mesmo utilizador) de ser inserida duas vezes.

alter table public.transactions
  add column if not exists dedup_key text;

comment on column public.transactions.dedup_key is
  'Chave estável (hash ou id bancário). UNIQUE por utilizador quando preenchida.';

-- Índice único completo (não parcial): PostgREST precisa disto para
-- upsert com onConflict 'user_id,dedup_key'. Em PostgreSQL, várias linhas com
-- dedup_key IS NULL são permitidas (NULL não conta como duplicado).
create unique index if not exists transactions_user_dedup_key_uidx
  on public.transactions (user_id, dedup_key);
