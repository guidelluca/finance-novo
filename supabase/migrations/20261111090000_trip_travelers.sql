-- Quantas pessoas a viagem cobre (para ver os gastos no total ou por pessoa).
alter table public.trips add column if not exists travelers smallint not null default 1 check (travelers between 1 and 12);
notify pgrst, 'reload schema';
