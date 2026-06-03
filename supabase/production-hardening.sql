-- ============================================================================
-- 10. Production hardening — consent/age audit, runtime app-config (kill-switch),
--     signup gating, abuse/operator audit log, daily_usage retention.
--     Idempotent / safe to re-run. Run last (after sections 1–9).
-- ============================================================================

-- ── 10a. Consent + age audit on users ──────────────────────────────────────
-- Recorded server-side at signup (see /api/auth/signup). Append-only audit:
-- never cleared, so you can prove what version a user accepted and when.
alter table public.users add column if not exists tos_version       text;
alter table public.users add column if not exists tos_accepted_at   timestamptz;
alter table public.users add column if not exists privacy_version   text;
alter table public.users add column if not exists age_attested_at   timestamptz;

-- ── 10b. Runtime app config (singleton) — instant kill-switch, no redeploy ──
-- One row, read by lib/app-config.ts with a short in-process cache. Flip these
-- from the SQL editor (or the operator route) to pause signups / disable AI /
-- change the signup gate WITHOUT a redeploy.
create table if not exists public.app_config (
  id                   boolean primary key default true,
  signups_paused       boolean not null default false,   -- block all new signups
  ai_disabled          boolean not null default false,   -- hard-stop every AI route
  signup_mode          text    not null default 'open',  -- 'open' | 'invite' | 'edu'
  allowed_email_domains text[] not null default '{}',    -- for signup_mode='edu' (e.g. {'edu'} or {'mit.edu'})
  updated_at           timestamptz not null default now(),
  constraint app_config_singleton check (id = true),
  constraint app_config_signup_mode_chk check (signup_mode in ('open','invite','edu'))
);
insert into public.app_config (id) values (true) on conflict (id) do nothing;

alter table public.app_config enable row level security;
-- No anon/authenticated policy → RLS denies them by default. Only service_role
-- (which bypasses RLS) reads/writes it. Explicit revoke for defense in depth.
revoke all on public.app_config from anon, authenticated;

-- ── 10c. Invite codes (for signup_mode='invite') ───────────────────────────
-- Single-use codes consumed atomically by consume_invite_code() at signup.
create table if not exists public.invite_codes (
  code       text primary key,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  used_by    uuid,
  note       text
);
-- used_by is a plain uuid (no FK): the gating trigger sets it during the signup
-- transaction BEFORE the auth.users row exists, so an FK to auth.users(id) would
-- fail; and an audit column is better off surviving user deletion anyway. Drop
-- the FK if an earlier version created it.
alter table public.invite_codes drop constraint if exists invite_codes_used_by_fkey;
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;

-- Atomically claim an unused code. Returns true if claimed, false if missing/used.
-- SECURITY DEFINER + service-role only (called from the server signup route).
create or replace function public.consume_invite_code(p_code text, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.invite_codes
     set used_at = now(), note = coalesce(note,'') || ' email:' || coalesce(p_email,'')
   where code = p_code and used_at is null
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;
revoke all      on function public.consume_invite_code(text, text) from anon, authenticated, public;
grant  execute  on function public.consume_invite_code(text, text) to service_role;

-- ── 10d. Abuse / operator audit log ─────────────────────────────────────────
-- Append-only record of security-relevant events for an operator to review:
-- suspensions, blocked signups, moderation blocks, data exports, etc.
create table if not exists public.audit_log (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  actor           text not null,            -- 'system' | 'operator' | a user_id
  action          text not null,            -- e.g. 'suspend_user','signup_blocked','moderation_block','data_export'
  subject_user_id uuid,
  detail          jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_subject_idx on public.audit_log (subject_user_id, created_at desc);
create index if not exists audit_log_action_idx  on public.audit_log (action, created_at desc);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

-- ── 10e. Operator: suspend / unsuspend (audited) ────────────────────────────
-- Called by /api/operator/* (gated behind OPERATOR_SECRET). SECURITY DEFINER so
-- it can update users + write the audit row atomically; service-role only.
create or replace function public.operator_set_suspended(p_user_id uuid, p_suspended boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set suspended = p_suspended where user_id = p_user_id;
  insert into public.audit_log (actor, action, subject_user_id, detail)
  values ('operator', case when p_suspended then 'suspend_user' else 'unsuspend_user' end,
          p_user_id, jsonb_build_object('reason', coalesce(p_reason,'')));
end;
$$;
revoke all     on function public.operator_set_suspended(uuid, boolean, text) from anon, authenticated, public;
grant  execute on function public.operator_set_suspended(uuid, boolean, text) to service_role;

-- ── 10f. daily_usage retention ──────────────────────────────────────────────
-- The abuse counter grows one row per (user, action, day) forever. Purge rows
-- older than 30 days. Called weekly by the maintenance cron (vercel.json).
create or replace function public.purge_old_daily_usage()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.daily_usage where day < (current_date - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all     on function public.purge_old_daily_usage() from anon, authenticated, public;
grant  execute on function public.purge_old_daily_usage() to service_role;

-- ── 10g. Signup gating ENFORCED at the database layer ───────────────────────
-- A BEFORE INSERT trigger on auth.users applies gating (signups_paused / invite
-- / edu) and atomic invite consumption to EVERY signup path — the server route,
-- a direct anon supabase.auth.signUp from the browser, AND Google OAuth — so it
-- cannot be bypassed client-side. It runs in the signup transaction, so a failed
-- signup rolls back any invite consumption (no more burned codes on failure).
create or replace function public.enforce_signup_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.app_config;
  v_email   text := lower(coalesce(NEW.email, ''));
  v_domain  text;
  v_code    text;
  v_claimed boolean;
begin
  select * into cfg from public.app_config where id is true;
  if not found then
    return NEW; -- section 10 not configured → behave as open (self-host/single-tenant)
  end if;

  if cfg.signups_paused then
    raise exception 'signups_paused' using errcode = 'check_violation';
  end if;

  if cfg.signup_mode = 'edu' then
    v_domain := split_part(v_email, '@', 2);
    if v_domain = '' or not exists (
      select 1 from unnest(cfg.allowed_email_domains) d
      where v_domain = lower(replace(d, '*.', ''))
         or v_domain like '%.' || lower(replace(d, '*.', ''))
    ) then
      raise exception 'email_not_allowed' using errcode = 'check_violation';
    end if;
  elsif cfg.signup_mode = 'invite' then
    v_code := NEW.raw_user_meta_data->>'invite_code';
    if v_code is null or v_code = '' then
      raise exception 'invite_required' using errcode = 'check_violation';
    end if;
    update public.invite_codes
       set used_at = now(), used_by = NEW.id,
           note = coalesce(note, '') || ' email:' || v_email
     where code = v_code and used_at is null
    returning true into v_claimed;
    if not coalesce(v_claimed, false) then
      raise exception 'invalid_invite' using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists enforce_signup_policy_trg on auth.users;
create trigger enforce_signup_policy_trg
  before insert on auth.users
  for each row execute function public.enforce_signup_policy();

-- ── 10h. GDPR export: catalog lookup via SQL ────────────────────────────────
-- information_schema is not reachable through PostgREST, so the export route
-- discovers user-scoped tables via this SECURITY DEFINER RPC instead.
create or replace function public.list_user_scoped_tables()
returns setof text
language sql
security definer
set search_path = public
as $$
  select c.table_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'user_id'
    and t.table_type = 'BASE TABLE';
$$;
revoke all     on function public.list_user_scoped_tables() from anon, authenticated, public;
grant  execute on function public.list_user_scoped_tables() to service_role;
