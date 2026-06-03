-- ============================================================
-- USAGE LIMITS / ABUSE GUARDS (hosted multi-tenant)
-- Daily per-user caps on expensive AI routes + an account suspend flag.
-- Idempotent / safe to re-run.
-- ============================================================

-- Per-user, per-action, per-day counter.
create table if not exists public.daily_usage (
  user_id uuid not null references public.users(user_id) on delete cascade,
  action  text not null,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, action, day)
);

alter table public.daily_usage enable row level security;
drop policy if exists "daily_usage: own rows only" on public.daily_usage;
create policy "daily_usage: own rows only" on public.daily_usage
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Atomic "increment and check" — returns true if still within the limit.
-- SECURITY DEFINER + service-role only (called from server routes), consistent
-- with the rest of the hardened RPCs.
create or replace function public.consume_daily_quota(p_user_id uuid, p_action text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.daily_usage (user_id, action, day, count)
  values (p_user_id, p_action, current_date, 1)
  on conflict (user_id, action, day) do update set count = public.daily_usage.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

revoke execute on function public.consume_daily_quota(uuid, text, int) from anon, authenticated, public;
grant  execute on function public.consume_daily_quota(uuid, text, int) to service_role;

-- Account suspend flag (abuse response). Checked by the AI routes.
alter table public.users add column if not exists suspended boolean not null default false;
