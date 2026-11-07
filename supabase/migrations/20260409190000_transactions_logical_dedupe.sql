-- Remove lançamentos duplicados (mesmo utilizador, data, valor, tipo e descrição lógica)
-- e impede novos duplicados com índice único.

-- Mantém um registo por grupo: prioriza linha com categoria, depois com import, depois a mais antiga.
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
        (import_file_id IS NOT NULL) DESC,
        created_at ASC NULLS LAST,
        id ASC
    ) AS rn
  FROM public.transactions
)
DELETE FROM public.transactions t
WHERE t.id IN (SELECT id FROM ranked WHERE rn > 1);

-- Coluna gerada = mesma lógica da partição acima (alinhada ao cliente em dedupKey.ts).
-- Usamos `(date - DATE '1970-01-01')` porque `date::text` não é IMMUTABLE (depende de DateStyle)
-- e Postgres exige expressão IMMUTABLE em GENERATED ALWAYS AS ... STORED.
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

COMMENT ON COLUMN public.transactions.logical_fingerprint IS
  'Hash estável por (utilizador, data, valor, tipo, descrição normalizada); único por utilizador.';

-- Índice único: um lançamento lógico por utilizador
DROP INDEX IF EXISTS transactions_user_logical_fingerprint_uidx;
CREATE UNIQUE INDEX transactions_user_logical_fingerprint_uidx
  ON public.transactions (user_id, logical_fingerprint);
