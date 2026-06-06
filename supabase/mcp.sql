-- ============================================================
-- COGNI — MCP ("bring your own Claude") connector
-- Idempotent: safe to run more than once.
-- Folded into setup.sql (Section 11).
-- ============================================================

-- Per-user bearer tokens for the Cogni MCP server. A user connects their own Claude
-- client (Claude Code / Desktop) to Cogni's MCP endpoint with one of these; every
-- tool call is scoped to that user's data. Only the SHA-256 hash is stored.
-- user_id is the PRIMARY KEY → at most one active token per user (regenerating
-- atomically replaces it). token_hash is uniquely indexed for the auth lookup.
create table if not exists public.mcp_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  label      text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz
);
alter table public.mcp_tokens enable row level security;
-- No policies: only the server (service role) reads/writes these; RLS denies anon/authenticated.

-- Token expiry (F4): new tokens get created_at + 180 days; NULL = legacy token,
-- still honored until regenerated.
alter table public.mcp_tokens add column if not exists expires_at timestamptz;

-- Opt-in: route the in-app Tutor tab to the user's own Claude (via MCP) instead of
-- the built-in BYOK-API tutor.
alter table public.users add column if not exists prefer_own_claude boolean not null default false;

-- Per-invocation audit of MCP tool calls (F4): the MCP surface previously logged
-- nothing, so abuse or breakage was invisible. Service-role only (RLS, no policies).
create table if not exists public.mcp_tool_calls (
  call_id    uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  tool       text not null,
  ok         boolean not null,
  detail     text,
  created_at timestamptz not null default now()
);
alter table public.mcp_tool_calls enable row level security;
create index if not exists idx_mcp_tool_calls_user_created on public.mcp_tool_calls(user_id, created_at);
