-- Corrige bases que já tinham o índice parcial (WHERE dedup_key IS NOT NULL).
-- Esse índice não satisfaz ON CONFLICT (user_id, dedup_key) no upsert do cliente.

drop index if exists transactions_user_dedup_key_uidx;

create unique index transactions_user_dedup_key_uidx
  on public.transactions (user_id, dedup_key);
