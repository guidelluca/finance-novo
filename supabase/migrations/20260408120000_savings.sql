-- Metas de poupança (“caixinhas”) + movimentos manuais (entradas/saídas).

create table public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target_cents bigint,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint savings_goals_name_nonempty check (length(trim(name)) > 0)
);

create index savings_goals_user_sort_idx on public.savings_goals (user_id, sort_order, name);

create table public.savings_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.savings_goals (id) on delete cascade,
  date date not null,
  amount_cents bigint not null,
  note text,
  created_at timestamptz not null default now()
);

create index savings_entries_user_date_idx on public.savings_entries (user_id, date desc);
create index savings_entries_goal_idx on public.savings_entries (goal_id, date desc);

alter table public.savings_goals enable row level security;
alter table public.savings_entries enable row level security;

create policy savings_goals_all_own on public.savings_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy savings_entries_all_own on public.savings_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
