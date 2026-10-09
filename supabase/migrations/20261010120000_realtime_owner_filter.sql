-- Poker Analytics 27 — realtime DELETE privacy fix.
--
-- Problem: Supabase Realtime (postgres_changes) enforces RLS on INSERT and
-- UPDATE only. realtime.apply_rls() skips the RLS check for DELETE ("we can't
-- secure deletes"), so every authenticated subscriber to public.sessions /
-- bankroll_transactions / user_settings received every other user's DELETE
-- event with the primary key (and, for user_settings, the owner's auth uid).
-- Reproduced by tests/realtime-delete-privacy.test.mjs.
--
-- Fix: apply_rls DOES evaluate subscription filters against the old row for
-- DELETE (replica identity full, set in the STEP A migration). So a BEFORE
-- INSERT/UPDATE trigger on realtime.subscription appends a server-enforced
-- `user_id = eq.<jwt sub>` filter to every subscription on these three tables.
-- Filters are ANDed, so whatever the client asks for, it can only ever match
-- its own rows. Non-owner roles without a `sub` are rejected; service_role
-- (which bypasses RLS anyway) is left untouched.
--
-- No client change is required: the web/native clients' INSERT/UPDATE
-- bindings already carry the same filter (deduplicated below) and their
-- unfiltered DELETE bindings become owner-only.
--
-- Depends on: replica identity full on the three tables (STEP A migration).
-- Caveat: realtime.subscription is owned by Supabase's Realtime service. If a
-- future Realtime upgrade recreates that table the trigger disappears; re-run
-- this file and the repro test after Realtime upgrades.
-- Idempotent: safe to re-run.

create or replace function public.pa27_realtime_owner_filter()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  owner_filter realtime.user_defined_filter;
  sub text = new.claims ->> 'sub';
  role_name text = new.claims ->> 'role';
begin
  if new.entity not in (
    'public.sessions'::regclass,
    'public.bankroll_transactions'::regclass,
    'public.user_settings'::regclass
  ) then
    return new;
  end if;

  if role_name = 'service_role' then
    return new;
  end if;

  if sub is null or sub = '' then
    raise exception 'pa27: realtime subscriptions on % require a signed-in user', new.entity;
  end if;

  owner_filter = row('user_id', 'eq', sub, false)::realtime.user_defined_filter;
  if not (owner_filter = any (coalesce(new.filters, '{}'))) then
    new.filters = coalesce(new.filters, '{}') || owner_filter;
  end if;
  return new;
end;
$$;

-- Trigger function only; never callable through PostgREST RPC.
revoke all on function public.pa27_realtime_owner_filter() from public, anon, authenticated;

-- Named to sort before Supabase's tr_check_filters, so the appended filter is
-- validated (column exists, value casts to uuid) by Realtime's own trigger.
drop trigger if exists pa27_owner_filter on realtime.subscription;
create trigger pa27_owner_filter
  before insert or update on realtime.subscription
  for each row execute function public.pa27_realtime_owner_filter();

-- Retrofit subscriptions that were live before the trigger existed.
update realtime.subscription
set filters = filters
where entity in (
  'public.sessions'::regclass,
  'public.bankroll_transactions'::regclass,
  'public.user_settings'::regclass
);
