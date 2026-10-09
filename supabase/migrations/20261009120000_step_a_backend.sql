-- Poker Analytics 27 — STEP A backend: per-user sessions, bankroll
-- transactions and settings, with RLS, updated_at triggers and realtime.
-- Column names follow the brief's data model (section 4) so the client maps
-- 1:1; `status` is a generated convenience column (live / ended).
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto;

-- updated_at maintenance -----------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- sessions -------------------------------------------------------------------
create table if not exists public.sessions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind                   text not null check (kind in ('cash', 'tournament')),
  -- references into user_settings.master_data (client-generated ids)
  game_id                text,
  location_id            text,
  bankroll_id            text,
  group_id               text,
  table_size             smallint check (table_size between 2 and 10),
  start_time             timestamptz not null,
  end_time               timestamptz,
  duration_seconds       integer check (duration_seconds >= 0),
  break_seconds          integer not null default 0 check (break_seconds >= 0),
  -- live tracking: elapsed = now - start_time - break_seconds - (now - paused_at)
  is_live                boolean not null default false,
  status                 text generated always as (case when is_live then 'live' else 'ended' end) stored,
  paused_at              timestamptz,
  hands_count            integer check (hands_count >= 0),
  hands_count_estimated  boolean not null default false,
  comment                text,
  opponents              text,
  tracked_via_stack      boolean not null default false,
  -- cash
  small_blind            numeric,
  big_blind              numeric,
  buy_in                 numeric,   -- only meaningful when tracked_via_stack = false
  cashed_out             numeric,
  tips                   numeric,
  -- tournament
  tournament_type_id     text,
  tournament_name        text,
  initial_buy_in         numeric,
  total_buy_in           numeric,
  prize                  numeric,
  position               integer,
  entries                integer,
  -- owned children: [{id, kind, amount, occurred_at}] / [{id, percentage, markup, backer_name}]
  stack_events           jsonb not null default '[]'::jsonb,
  sell_actions           jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint sessions_end_after_start check (end_time is null or end_time >= start_time),
  constraint sessions_stack_events_array check (jsonb_typeof(stack_events) = 'array'),
  constraint sessions_sell_actions_array check (jsonb_typeof(sell_actions) = 'array')
);

create index if not exists sessions_user_start_idx on public.sessions (user_id, start_time desc);
-- Brief section 6: only one live session at a time, enforced across devices.
create unique index if not exists sessions_one_live_per_user on public.sessions (user_id) where is_live;

-- bankroll_transactions --------------------------------------------------------
create table if not exists public.bankroll_transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  bankroll_id  text not null,
  kind         text not null check (kind in ('deposit', 'withdrawal', 'other')),
  amount       numeric not null,   -- signed
  description  text,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists bankroll_transactions_user_idx on public.bankroll_transactions (user_id, occurred_at desc);

-- user_settings: one row per user ------------------------------------------------
create table if not exists public.user_settings (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  currency        text not null default 'EUR',
  -- {bankrolls, locations, games, tournament_types, groups} — arrays of {id, name, ...}
  master_data     jsonb not null default '{}'::jsonb,
  player_notes    jsonb not null default '[]'::jsonb,
  hand_histories  jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- triggers ---------------------------------------------------------------------
drop trigger if exists sessions_set_updated_at on public.sessions;
create trigger sessions_set_updated_at before update on public.sessions
  for each row execute function public.set_updated_at();

drop trigger if exists bankroll_transactions_set_updated_at on public.bankroll_transactions;
create trigger bankroll_transactions_set_updated_at before update on public.bankroll_transactions
  for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

-- row level security: owner-only on every operation ---------------------------
alter table public.sessions enable row level security;
alter table public.bankroll_transactions enable row level security;
alter table public.user_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sessions', 'bankroll_transactions', 'user_settings'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)',
      t || '_owner_all', t);
  end loop;
end;
$$;

-- anon never touches these tables (policies above only grant authenticated).
revoke all on public.sessions, public.bankroll_transactions, public.user_settings from anon;
grant select, insert, update, delete on public.sessions, public.bankroll_transactions, public.user_settings to authenticated;

-- realtime -----------------------------------------------------------------------
-- Full replica identity so UPDATE/DELETE payloads carry the old row.
alter table public.sessions replica identity full;
alter table public.bankroll_transactions replica identity full;
alter table public.user_settings replica identity full;

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['sessions', 'bankroll_transactions', 'user_settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
