-- Finanças PWA — schema + RLS (Supabase)

create extension if not exists "uuid-ossp";

-- Categories (tree via parent_id)
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  parent_id uuid references public.categories (id) on delete set null,
  icon text,
  color text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index categories_user_parent_idx on public.categories (user_id, parent_id);

-- Import batches / files
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  parser_id text not null,
  parser_version text not null default 'v1',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.import_files (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  filename text not null,
  parser_id text not null,
  raw_error text,
  created_at timestamptz not null default now()
);

create index import_files_batch_idx on public.import_files (batch_id);

-- Transactions
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  amount_cents bigint not null,
  description_raw text not null,
  description_normalized text,
  kind text not null check (kind in ('debit', 'credit')),
  account text,
  category_id uuid references public.categories (id) on delete set null,
  import_batch_id uuid references public.import_batches (id) on delete set null,
  import_file_id uuid references public.import_files (id) on delete set null,
  created_at timestamptz not null default now()
);

create index transactions_user_date_idx on public.transactions (user_id, date desc);
create index transactions_user_category_idx on public.transactions (user_id, category_id);

-- Rules for auto-categorization
create table public.rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  match_type text not null check (match_type in ('contains', 'equals', 'regex')),
  pattern text not null,
  category_id uuid not null references public.categories (id) on delete cascade,
  priority int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index rules_user_enabled_idx on public.rules (user_id, enabled, priority desc);

alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_files enable row level security;
alter table public.rules enable row level security;

create policy categories_all_own on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy transactions_all_own on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy import_batches_all_own on public.import_batches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy import_files_all_via_batch on public.import_files
  for all using (
    exists (select 1 from public.import_batches b where b.id = batch_id and b.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.import_batches b where b.id = batch_id and b.user_id = auth.uid())
  );

create policy rules_all_own on public.rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
