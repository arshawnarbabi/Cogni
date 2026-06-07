-- ============================================================
-- COGNI — BIG UPDATE migration (run once on prod; idempotent)
-- Accumulates every schema change for the big update. Each block
-- is also folded into setup.sql so fresh installs get everything.
-- ============================================================

-- ── B12: topics + assignments de-dup & unique indexes ────────
-- Topics: consolidate case-insensitive duplicates (repoint children to the
-- oldest row, then delete dupes), then add the unique index the profiler's
-- upsert-on-conflict targets.
create temp table _topic_dups as
select t.topic_id as dup_id, k.topic_id as keep_id
from public.topics t
join lateral (
  select topic_id from public.topics k
  where k.user_id = t.user_id and k.course_id = t.course_id and lower(k.name) = lower(t.name)
  order by k.created_at asc, k.topic_id asc
  limit 1
) k on true
where k.topic_id <> t.topic_id;

update public.flashcards f set topic_id = d.keep_id from _topic_dups d where f.topic_id = d.dup_id;
update public.mastery_history h set topic_id = d.keep_id from _topic_dups d where h.topic_id = d.dup_id;
delete from public.topic_mastery tm using _topic_dups d where tm.topic_id = d.dup_id;
delete from public.topics t using _topic_dups d where t.topic_id = d.dup_id;
drop table _topic_dups;

create unique index if not exists topics_user_course_name_uniq
  on public.topics (user_id, course_id, name);

-- Assignments: keep one row per (user, course, name, due_date), then index.
delete from public.assignments a using public.assignments b
  where a.user_id = b.user_id and a.course_id = b.course_id
    and lower(coalesce(a.name, '')) = lower(coalesce(b.name, '')) and a.due_date = b.due_date
    and a.ctid < b.ctid;

-- NULLS NOT DISTINCT (PG15+): name is nullable, and with default semantics
-- null-name rows never conflict — the upsert's ON CONFLICT would silently
-- no-op as a dedup guard for them.
drop index if exists assignments_user_course_name_due_uniq;
create unique index if not exists assignments_user_course_name_due_uniq
  on public.assignments (user_id, course_id, name, due_date) nulls not distinct;

-- ── F3 + B6: unified mastery model + idempotent reviews ──────────────────────
-- review_card_atomic now takes evidence (observed level + learning rate, EWMA)
-- instead of an additive delta — all three mastery writers move the score on ONE
-- scale — plus a client_review_id idempotency gate and a review_logs ledger
-- (one row per rating; also the substrate for per-user FSRS optimization).
drop function if exists public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, integer, timestamptz, date, numeric
);
drop function if exists public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric
);
drop function if exists public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric, numeric
);

create table if not exists public.review_logs (
  log_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  card_id uuid not null references public.flashcards(card_id) on delete cascade,
  client_review_id uuid not null unique,
  rating smallint not null check (rating between 1 and 4),
  prev_stability numeric,
  prev_difficulty numeric,
  prev_state text,
  new_stability numeric,
  new_difficulty numeric,
  new_state text,
  next_review_date date,
  reviewed_at timestamptz not null default now()
);
alter table public.review_logs enable row level security;
do $$ begin
  create policy "review_logs: own rows only" on public.review_logs
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
create index if not exists idx_review_logs_user_reviewed on public.review_logs(user_id, reviewed_at);

create or replace function public.review_card_atomic(
  p_card_id uuid,
  p_user_id uuid,
  p_fsrs_stability numeric,
  p_fsrs_difficulty numeric,
  p_fsrs_reps integer,
  p_fsrs_lapses integer,
  p_fsrs_state text,
  p_fsrs_last_review timestamptz,
  p_fsrs_next_review_date date,
  p_observed numeric,
  p_learning_rate numeric,
  p_rating smallint,
  p_client_review_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card record;
  v_deck integer;
  v_lr numeric;
begin
  select card_id, topic_id, fsrs_stability, fsrs_difficulty, fsrs_state
  into v_card
  from public.flashcards
  where card_id = p_card_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'card not found or not owned by user';
  end if;

  insert into public.review_logs (
    user_id, card_id, client_review_id, rating,
    prev_stability, prev_difficulty, prev_state,
    new_stability, new_difficulty, new_state, next_review_date
  ) values (
    p_user_id, p_card_id, coalesce(p_client_review_id, gen_random_uuid()), p_rating,
    v_card.fsrs_stability, v_card.fsrs_difficulty, v_card.fsrs_state,
    p_fsrs_stability, p_fsrs_difficulty, p_fsrs_state, p_fsrs_next_review_date
  )
  on conflict (client_review_id) do nothing;

  if not found then
    return; -- duplicate submission — already applied exactly once
  end if;

  update public.flashcards
  set fsrs_stability = p_fsrs_stability,
      fsrs_difficulty = p_fsrs_difficulty,
      fsrs_reps = p_fsrs_reps,
      fsrs_lapses = p_fsrs_lapses,
      fsrs_state = p_fsrs_state,
      fsrs_last_review = p_fsrs_last_review,
      fsrs_next_review_date = p_fsrs_next_review_date
  where card_id = p_card_id
    and user_id = p_user_id;

  if v_card.topic_id is not null then
    -- Scale by 1/sqrt(deck size), counted under the lock (no extra round trip).
    select count(*) into v_deck
    from public.flashcards
    where user_id = p_user_id and topic_id = v_card.topic_id;
    v_lr := greatest(0, least(1, p_learning_rate)) / sqrt(greatest(1, v_deck));

    insert into public.topic_mastery (user_id, topic_id, mastery_score, confidence, last_updated)
    values (p_user_id, v_card.topic_id, greatest(0, least(1, p_observed)), 0.05, now())
    on conflict (user_id, topic_id) do update
      set mastery_score = greatest(0, least(1,
            coalesce(public.topic_mastery.mastery_score, 0)
            + v_lr
              * (greatest(0, least(1, p_observed)) - coalesce(public.topic_mastery.mastery_score, 0)))),
          confidence = least(1, coalesce(public.topic_mastery.confidence, 0) + 0.05),
          last_updated = now();

    insert into public.mastery_history (user_id, topic_id, mastery_score)
    select user_id, topic_id, mastery_score
    from public.topic_mastery
    where user_id = p_user_id
      and topic_id = v_card.topic_id;
  end if;
end;
$$;

-- service_role ONLY: SECURITY DEFINER + p_user_id parameter means anyone who
-- can execute it can replay it against another user's card. A freshly-created
-- function gets Postgres's default EXECUTE-to-PUBLIC grant, so the revoke is
-- REQUIRED — without it any anon-key holder could rewrite other users' FSRS
-- and mastery state.
revoke all on function public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric, numeric, smallint, uuid
) from anon, authenticated, public;
grant execute on function public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric, numeric, smallint, uuid
) to service_role;

-- review_card_atomic counts the topic's deck on every rating — make it an index scan.
create index if not exists idx_flashcards_user_topic on public.flashcards(user_id, topic_id);

-- ── R5: BYOK key health ───────────────────────────────────────────────────────
-- 'invalid' | 'no_credits' | NULL (healthy/unknown). Written by the withRetry
-- circuit breaker on provider auth/credit failures, cleared on success and on
-- key (re-)save. Surfaced as a "your key is broken" banner.
alter table public.users add column if not exists anthropic_key_status text
  check (anthropic_key_status in ('invalid', 'no_credits') or anthropic_key_status is null);
alter table public.users add column if not exists openai_key_status text
  check (openai_key_status in ('invalid', 'no_credits') or openai_key_status is null);

-- ── F4: MCP guard layer — token expiry + tool-call audit ─────────────────────
-- mcp_tokens may not exist on a prod DB that never ran mcp.sql (the optional
-- BYO-Claude connector). Create it idempotently first — ADD COLUMN IF NOT
-- EXISTS guards the column, not the table, so the bare ALTER would abort.
create table if not exists public.mcp_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  label      text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz
);
alter table public.mcp_tokens enable row level security;
alter table public.users add column if not exists prefer_own_claude boolean not null default false;

alter table public.mcp_tokens add column if not exists expires_at timestamptz;

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

-- ======================================================================
-- Section 12: Durable job substrate (F1)
-- ======================================================================
-- The ingest pipeline's heavy work (profiling, embedding, flashcard generation)
-- previously ran inline in request handlers (serverless-timeout risk) or as
-- fire-and-forget promises (a throw after the HTTP 200 silently lost the work,
-- with no retry surface). Jobs are durable rows: enqueued in the request,
-- drained post-response (next/server after()) and swept by the daily cron.
-- claim_jobs() also reclaims jobs whose lock expired (instance died mid-run)
-- and fails ones that exhausted their attempts — the stuck-job reaper (R8).
create table if not exists public.jobs (
  job_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  kind text not null check (kind in ('profile', 'embed', 'flashcards')),
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.jobs enable row level security;
-- No policies: only the server (service role) touches jobs.
create index if not exists idx_jobs_claimable on public.jobs(status, run_after);
create index if not exists idx_jobs_user on public.jobs(user_id, created_at);

-- Atomically claim up to p_limit due jobs (FOR UPDATE SKIP LOCKED so concurrent
-- drains never double-claim). Also: (1) reclaims 'running' jobs whose lock
-- expired — the worker died mid-job; (2) fails jobs that exhausted attempts.
create or replace function public.claim_jobs(p_limit int default 5)
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Exhausted jobs → failed (visible, not eternally retried).
  update public.jobs
  set status = 'failed',
      last_error = coalesce(last_error, '') || ' [max attempts exhausted]',
      updated_at = now()
  where ((status = 'queued' and run_after <= now())
      or (status = 'running' and locked_until is not null and locked_until < now()))
    and attempts >= max_attempts;

  return query
  update public.jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_until = now() + interval '10 minutes',
      updated_at = now()
  where j.job_id in (
    select job_id from public.jobs
    where ((status = 'queued' and run_after <= now())
        or (status = 'running' and locked_until is not null and locked_until < now()))
      and attempts < max_attempts
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning j.*;
end;
$$;

revoke all on function public.claim_jobs(int) from anon, authenticated, public;
grant execute on function public.claim_jobs(int) to service_role;

-- ======================================================================
-- Section 13: Persistent tutor memory (M1 + M2)
-- ======================================================================
-- Episodic memory: one distilled row per finished tutoring session (what was
-- covered, what confused the student, what they got right, stated preferences).
-- Written by lib/agents/memory.ts (one Haiku call per session close).
create table if not exists public.session_summaries (
  summary_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  session_id uuid not null unique references public.session_log(session_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  summary text not null,
  confusions text[],
  understood text[],
  preferences text[],
  topics_discussed uuid[],
  message_count integer,
  created_at timestamptz not null default now()
);
alter table public.session_summaries enable row level security;
drop policy if exists "session_summaries: own rows only" on public.session_summaries;
create policy "session_summaries: own rows only" on public.session_summaries
  for select using (auth.uid() = user_id);
create index if not exists idx_session_summaries_user_course on public.session_summaries(user_id, course_id, created_at);

-- Rolling per-course digest: ONE capped narrative per (user, course) — what's
-- been covered across all sessions, persistent confusions, stable preferences.
-- O(1) prompt tokens per tutor request no matter how many sessions exist.
create table if not exists public.course_memory (
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  digest text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);
alter table public.course_memory enable row level security;
drop policy if exists "course_memory: own rows only" on public.course_memory;
create policy "course_memory: own rows only" on public.course_memory
  for select using (auth.uid() = user_id);

-- In-session history compaction (M6): once a session transcript outgrows the
-- verbatim window, the older prefix is summarized once and cached here instead
-- of being re-sent (and re-billed) on every subsequent turn.
alter table public.session_log add column if not exists history_summary text;
alter table public.session_log add column if not exists history_summary_upto integer;

-- MCP-logged study sessions (X3) get their own mode value.
alter table public.session_log drop constraint if exists session_log_mode_check;
alter table public.session_log add constraint session_log_mode_check
  check (mode in ('answer', 'teach', 'focus', 'essay', 'mcp', 'homework'));

-- The memory distiller runs as a durable job.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('profile', 'embed', 'flashcards', 'distill'));

-- ── I10: RAG similarity floor — match_material_chunks returns similarity ────
-- I10: now returns the cosine similarity so callers can apply a relevance
-- floor — "top-5 no matter how irrelevant" injected garbage as authoritative
-- context when nothing matched. Return-type change requires a drop first.
drop function if exists match_material_chunks(uuid, uuid, vector, integer);

create or replace function match_material_chunks(
  p_user_id    uuid,
  p_course_id  uuid,
  p_query_embedding vector(1536),
  p_top_k      integer default 5
)
returns table (
  material_id  uuid,
  chunk_index  integer,
  content      text,
  similarity   double precision
)
language sql
stable
as $$
  select
    me.material_id,
    me.chunk_index,
    me.content,
    1 - (me.embedding <=> p_query_embedding) as similarity
  from material_embeddings me
  join materials m on m.material_id = me.material_id
  where me.user_id = p_user_id
    and m.course_id = p_course_id
    and me.embedding is not null
  order by me.embedding <=> p_query_embedding
  limit p_top_k;
$$;

grant execute on function match_material_chunks(uuid, uuid, vector, integer) to service_role;

-- ======================================================================
-- Section 14: Structured student memory (M3) + prerequisite graph (I5)
-- ======================================================================
-- Typed, machine-readable facts about the student (vs. the prose digest in
-- course_memory): preferences, recurring misconceptions, goals. Written by the
-- session distiller; consumed by the scheduler (misconception boosts, M8) and
-- editable/deletable by the student in Settings (M7).
create table if not exists public.student_memory (
  memory_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid references public.courses(course_id) on delete cascade,
  topic_id uuid references public.topics(topic_id) on delete cascade,
  kind text not null check (kind in ('preference', 'misconception', 'goal', 'fact')),
  content text not null,
  source_session_id uuid references public.session_log(session_id) on delete set null,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.student_memory enable row level security;
drop policy if exists "student_memory: own rows only" on public.student_memory;
create policy "student_memory: own rows only" on public.student_memory
  for select using (auth.uid() = user_id);
create index if not exists idx_student_memory_user_course on public.student_memory(user_id, course_id, last_seen);

-- Memory pause (M7): when true, the distiller stops writing new memory
-- (existing memory is kept until the user deletes it).
alter table public.users add column if not exists memory_paused boolean not null default false;

-- Prerequisite edges between topics (I5): extracted by the profiler from the
-- syllabus ordering/structure. Drives "your prereq is weak" remediation in the
-- tutor and a scheduler boost for weak prerequisites of upcoming work.
create table if not exists public.topic_prerequisites (
  topic_id uuid not null references public.topics(topic_id) on delete cascade,
  prereq_topic_id uuid not null references public.topics(topic_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (topic_id, prereq_topic_id)
);
alter table public.topic_prerequisites enable row level security;
drop policy if exists "topic_prerequisites: own rows only" on public.topic_prerequisites;
create policy "topic_prerequisites: own rows only" on public.topic_prerequisites
  for select using (auth.uid() = user_id);
create index if not exists idx_topic_prereq_user_course on public.topic_prerequisites(user_id, course_id);

-- ── S4: ICS calendar feed token ──────────────────────────────────────────────
alter table public.users add column if not exists calendar_feed_token uuid;
create index if not exists idx_users_calendar_feed_token on public.users(calendar_feed_token) where calendar_feed_token is not null;

-- ======================================================================
-- Section 16: Incremental embeddings (C4 + R4)
-- ======================================================================
-- content_hash lets re-embeds skip unchanged chunks (re-runs were silently
-- re-billing the student's OpenAI key for identical text), and the unique
-- (material_id, chunk_index) index turns the old delete-all-then-reinsert —
-- which left a material with ZERO embeddings if a batch failed mid-loop —
-- into an atomic upsert-per-chunk swap.
alter table public.material_embeddings add column if not exists content_hash text;
-- Backfill so pre-existing rows hash-match what lib/rag.ts computes (sha256 hex
-- of the content text) — without this, the first re-embed of every existing
-- material would re-bill the student's OpenAI key for unchanged chunks.
create extension if not exists pgcrypto;
update public.material_embeddings
  set content_hash = encode(digest(content, 'sha256'), 'hex')
  where content_hash is null;
-- Defensive de-dup before the unique index (the old path could not create
-- duplicates, but a reused DB might have them).
delete from public.material_embeddings a using public.material_embeddings b
  where a.material_id = b.material_id and a.chunk_index = b.chunk_index and a.ctid < b.ctid;
create unique index if not exists material_embeddings_material_chunk_uniq
  on public.material_embeddings(material_id, chunk_index);

-- ======================================================================
-- Section 17: Usage & cost transparency (C7)
-- ======================================================================
-- BYOK means the student pays — and previously flew blind (the tutor logged
-- token usage to console and threw it away). One row per model call; the
-- Settings panel aggregates spend by surface and shows what caching saved.
create table if not exists public.usage_events (
  event_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  surface text not null,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.usage_events enable row level security;
drop policy if exists "usage_events: own rows only" on public.usage_events;
create policy "usage_events: own rows only" on public.usage_events
  for select using (auth.uid() = user_id);
create index if not exists idx_usage_events_user_created on public.usage_events(user_id, created_at);

-- ======================================================================
-- Section 18: Grade tracking (S1) + LMS/Canvas connections (S5)
-- ======================================================================
-- The grading scheme per course (category weights), seeded by the profiler
-- from the syllabus and editable by the student.
create table if not exists public.course_grade_schemes (
  scheme_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  category text not null,
  weight_pct numeric(5,2) not null check (weight_pct >= 0 and weight_pct <= 100),
  created_at timestamptz not null default now(),
  unique (user_id, course_id, category)
);
alter table public.course_grade_schemes enable row level security;
drop policy if exists "course_grade_schemes: own rows only" on public.course_grade_schemes;
create policy "course_grade_schemes: own rows only" on public.course_grade_schemes
  for select using (auth.uid() = user_id);

-- Individual graded items (manual entry or Canvas-synced). external_id carries
-- the Canvas assignment id so re-syncs update instead of duplicating.
create table if not exists public.grade_items (
  item_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  category text,
  name text not null,
  points_earned numeric(8,2),
  points_possible numeric(8,2) not null check (points_possible > 0),
  graded_at timestamptz not null default now(),
  source text not null default 'manual' check (source in ('manual', 'canvas', 'exam')),
  external_id text,
  created_at timestamptz not null default now()
);
alter table public.grade_items enable row level security;
drop policy if exists "grade_items: own rows only" on public.grade_items;
create policy "grade_items: own rows only" on public.grade_items
  for select using (auth.uid() = user_id);
create index if not exists idx_grade_items_user_course on public.grade_items(user_id, course_id);
-- One row per Canvas assignment per course (re-sync upserts on this).
create unique index if not exists grade_items_external_uniq
  on public.grade_items(user_id, course_id, external_id) where external_id is not null;

-- Canvas connection (S5): one per user. The access token itself lives in the
-- Vault (user_keys secret 'canvas_token'), never in a table column.
create table if not exists public.lms_connections (
  user_id uuid primary key references public.users(user_id) on delete cascade,
  provider text not null default 'canvas' check (provider in ('canvas')),
  base_url text not null,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.lms_connections enable row level security;
drop policy if exists "lms_connections: own rows only" on public.lms_connections;
create policy "lms_connections: own rows only" on public.lms_connections
  for select using (auth.uid() = user_id);

-- Map Cogni courses to Canvas courses for sync.
alter table public.courses add column if not exists lms_course_id text;

-- ======================================================================
-- Section 19: Exam-linked practice attempts (S6)
-- ======================================================================
-- Ties a simulated exam attempt to the REAL exam it preps for, so attempt
-- trends per exam are queryable and readiness can cite them.
alter table public.practice_test_results add column if not exists exam_id uuid references public.exams(exam_id) on delete set null;
create index if not exists idx_practice_results_exam on public.practice_test_results(exam_id) where exam_id is not null;

-- PostgREST must see the new unique indexes + function signature before the
-- app's upsert-on-conflict / RPC calls work.
notify pgrst, 'reload schema';

-- Confirm
select
  (select count(*) from pg_indexes where indexname = 'topics_user_course_name_uniq') as topics_idx,
  (select count(*) from pg_indexes where indexname = 'assignments_user_course_name_due_uniq') as assignments_idx;
