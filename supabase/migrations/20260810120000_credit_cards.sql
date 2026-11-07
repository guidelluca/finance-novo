-- Cartões de crédito + vínculo opcional em transações.
-- Cada cartão tem dia de fechamento e dia de vencimento; a "fatura" de
-- referência (label mês/ano) usa o mês do VENCIMENTO, que é a convenção
-- mais comum no Brasil ("fatura de outubro" = fecha em set, vence em out).

create table if not exists public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  last4 text,
  brand text,
  limit_cents bigint,
  closing_day smallint not null default 1 check (closing_day between 1 and 31),
  due_day smallint not null default 10 check (due_day between 1 and 31),
  color text,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint credit_cards_name_nonempty check (length(trim(name)) > 0)
);

create index if not exists credit_cards_user_sort_idx
  on public.credit_cards (user_id, archived, sort_order, name);

alter table public.credit_cards enable row level security;

drop policy if exists credit_cards_all_own on public.credit_cards;
create policy credit_cards_all_own on public.credit_cards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Vínculo transação → cartão (nullable; para lançamentos que não são de cartão).
alter table public.transactions
  add column if not exists credit_card_id uuid
  references public.credit_cards (id) on delete set null;

create index if not exists transactions_credit_card_idx
  on public.transactions (credit_card_id, date desc)
  where credit_card_id is not null;
