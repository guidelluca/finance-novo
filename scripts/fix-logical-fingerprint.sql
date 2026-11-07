-- Corrige o schema do projeto Supabase atual para suportar dedup por
-- (user_id, date, amount, kind, descrição normalizada).
--
-- COMO USAR:
--   Opção 1 — SQL Editor do Supabase (recomendado):
--     1. Abrir https://supabase.com/dashboard/project/<ref>/sql/new
--     2. Colar o conteúdo deste arquivo inteiro
--     3. Clicar Run
--
--   Opção 2 — psql local (se tiveres a Connection String em Settings → Database):
--     psql "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
--       -f scripts/fix-logical-fingerprint.sql

-- 1. Coluna gerada `logical_fingerprint` (usa `(date - DATE '1970-01-01')` porque
--    `date::text` não é IMMUTABLE — bloqueia o CREATE GENERATED COLUMN).
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS logical_fingerprint text
  GENERATED ALWAYS AS (
    md5(
      user_id::text
      || '|'
      || (date - DATE '1970-01-01')::text
      || '|'
      || amount_cents::text
      || '|'
      || kind::text
      || '|'
      || lower(trim(coalesce(nullif(trim(description_normalized), ''), description_raw)))
    )
  ) STORED;

-- 2. Remove duplicados existentes antes de aplicar o índice único.
--    Prioriza manter linha COM categoria → COM cartão → COM import → mais antiga.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        user_id,
        date,
        amount_cents,
        kind,
        lower(trim(coalesce(nullif(trim(description_normalized), ''), description_raw)))
      ORDER BY
        (category_id IS NOT NULL) DESC,
        (credit_card_id IS NOT NULL) DESC,
        (import_file_id IS NOT NULL) DESC,
        created_at ASC NULLS LAST,
        id ASC
    ) AS rn
  FROM public.transactions
)
DELETE FROM public.transactions t
WHERE t.id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. Índice único que impede novos duplicados.
DROP INDEX IF EXISTS transactions_user_logical_fingerprint_uidx;
CREATE UNIQUE INDEX transactions_user_logical_fingerprint_uidx
  ON public.transactions (user_id, logical_fingerprint);

COMMENT ON COLUMN public.transactions.logical_fingerprint IS
  'Hash estável por (utilizador, data, valor, tipo, descrição normalizada); único por utilizador.';
