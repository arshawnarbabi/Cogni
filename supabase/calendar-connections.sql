-- Run in Supabase SQL Editor (Phase 11 — Calendar Integration)

create table public.calendar_connections (
  connection_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  provider text not null check (provider in ('google', 'apple', 'outlook')),
  access_token text, -- deprecated; secrets are stored in Supabase Vault
  refresh_token text, -- deprecated; secrets are stored in Supabase Vault
  expires_at timestamptz,
  cogni_calendar_id text, -- ID of the "Cogni Study" calendar created by us
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

alter table public.calendar_connections enable row level security;

create policy "calendar_connections: own rows only" on public.calendar_connections
  for all using (auth.uid() = user_id);
