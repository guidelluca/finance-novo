-- Viagens / projetos com controle de gastos (intercâmbio, réveillon, viagens curtas).
-- trips: a viagem; trip_items: gastos planejados (podem ser parcelados);
-- trip_transactions: lançamentos do extrato/fatura ligados à viagem (e, opcionalmente, a um item planejado).

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  destination text,
  start_date date,
  end_date date,
  budget_cents bigint,
  keywords text[] not null default '{}',
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  constraint trips_name_nonempty check (length(trim(name)) > 0)
);
create index if not exists trips_user_idx on public.trips (user_id, archived, start_date);

create table if not exists public.trip_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  category text not null default 'outros',
  description text not null,
  amount_cents bigint not null,
  installments smallint not null default 1 check (installments between 1 and 48),
  first_date date,
  created_at timestamptz not null default now()
);
create index if not exists trip_items_trip_idx on public.trip_items (trip_id);

create table if not exists public.trip_transactions (
  trip_id uuid not null references public.trips (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid references public.trip_items (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (trip_id, transaction_id)
);
create index if not exists trip_transactions_user_idx on public.trip_transactions (user_id, transaction_id);

alter table public.trips enable row level security;
alter table public.trip_items enable row level security;
alter table public.trip_transactions enable row level security;

drop policy if exists trips_all_own on public.trips;
create policy trips_all_own on public.trips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists trip_items_all_own on public.trip_items;
create policy trip_items_all_own on public.trip_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists trip_transactions_all_own on public.trip_transactions;
create policy trip_transactions_all_own on public.trip_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- avisa a API do Supabase que existem tabelas novas (sem isso o app pode levar alguns minutos para enxergá-las)
notify pgrst, 'reload schema';
