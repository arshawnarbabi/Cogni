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
  last_used_at timestamptz
);
alter table public.mcp_tokens enable row level security;
-- No policies: only the server (service role) reads/writes these; RLS denies anon/authenticated.

-- Opt-in: route the in-app Tutor tab to the user's own Claude (via MCP) instead of
-- the built-in BYOK-API tutor.
alter table public.users add column if not exists prefer_own_claude boolean not null default false;
