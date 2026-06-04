-- ============================================================
-- HOSTED MULTI-TENANT SECURITY HARDENING (Phase 0)
-- Run after the rest of the schema. Idempotent / safe to re-run.
-- Required before opening public sign-up.
-- ============================================================

-- ── 1. Lock down exposed SECURITY DEFINER RPCs ───────────────
-- These functions are SECURITY DEFINER and take a caller-supplied user_id with
-- NO internal auth.uid() check, and they are reachable via the public Data API
-- (PostgREST) by anyone holding the public anon key. Postgres grants EXECUTE to
-- PUBLIC by default, so without these REVOKEs any visitor can decrypt every
-- user's API keys (get_user_*) or rewrite another user's flashcard state
-- (review_card_atomic). The app only ever calls them with the service-role
-- client, which retains EXECUTE, so revoking from anon/authenticated/public is
-- safe and closes the hole.

revoke execute on function public.get_user_api_key(uuid)                         from anon, authenticated, public;
revoke execute on function public.get_user_secret(uuid, text)                    from anon, authenticated, public;
revoke execute on function public.store_user_api_key(uuid, text)                 from anon, authenticated, public;
revoke execute on function public.store_user_secret(uuid, text, text)            from anon, authenticated, public;
revoke execute on function public.delete_user_api_key(uuid)                      from anon, authenticated, public;
revoke execute on function public.delete_user_secret(uuid, text)                 from anon, authenticated, public;
revoke execute on function public.review_card_atomic(uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric)
                                                                                 from anon, authenticated, public;

-- Re-assert that only the service role (used by all server routes) can call them.
grant execute on function public.get_user_api_key(uuid)                          to service_role;
grant execute on function public.get_user_secret(uuid, text)                     to service_role;
grant execute on function public.store_user_api_key(uuid, text)                  to service_role;
grant execute on function public.store_user_secret(uuid, text, text)             to service_role;
grant execute on function public.delete_user_api_key(uuid)                       to service_role;
grant execute on function public.delete_user_secret(uuid, text)                  to service_role;
grant execute on function public.review_card_atomic(uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric)
                                                                                 to service_role;

-- ── 2. Explicit WITH CHECK on all 18 user-scoped policies ────
-- PostgreSQL already falls back to the USING expression as the implicit
-- WITH CHECK, so this is defense-in-depth: it makes the INSERT/UPDATE row
-- constraint explicit instead of relying on the engine default. ALTER POLICY
-- preserves the existing USING clause and is idempotent.

alter policy "users: own row only" on public.users with check (auth.uid() = user_id);
alter policy "professors: own rows only" on public.professors with check (auth.uid() = user_id);
alter policy "courses: own rows only" on public.courses with check (auth.uid() = user_id);
alter policy "topics: own rows only" on public.topics with check (auth.uid() = user_id);
alter policy "topic_mastery: own rows only" on public.topic_mastery with check (auth.uid() = user_id);
alter policy "flashcards: own rows only" on public.flashcards with check (auth.uid() = user_id);
alter policy "exams: own rows only" on public.exams with check (auth.uid() = user_id);
alter policy "assignments: own rows only" on public.assignments with check (auth.uid() = user_id);
alter policy "materials: own rows only" on public.materials with check (auth.uid() = user_id);
alter policy "inbox_items: own rows only" on public.inbox_items with check (auth.uid() = user_id);
alter policy "session_log: own rows only" on public.session_log with check (auth.uid() = user_id);
alter policy "session_messages: own rows only" on public.session_messages with check (auth.uid() = user_id);
alter policy "nudges: own rows only" on public.nudges with check (auth.uid() = user_id);
alter policy "wiki_versions: own rows only" on public.wiki_versions with check (auth.uid() = user_id);
alter policy "study_plan: own rows only" on public.study_plan with check (auth.uid() = user_id);
alter policy "mastery_history: own rows only" on public.mastery_history with check (auth.uid() = user_id);
alter policy "material_embeddings: own rows only" on public.material_embeddings with check (auth.uid() = user_id);
alter policy "calendar_connections: own rows only" on public.calendar_connections with check (auth.uid() = user_id);

-- ── 3. Unique constraints behind the de-dup logic ───────────
-- onboarding/complete dedupes professors/courses by name (select-then-insert =
-- TOCTOU), and courses/create inserts a professor unconditionally (duplicates
-- on every course-create). These unique indexes make the dedup race-safe and
-- let the routes use upsert-on-conflict.
-- A unique index can't be created while duplicate (user_id, name) rows exist —
-- which a project predating this constraint may have. So de-dupe first (keep one
-- row per group). Duplicates are already invalid under the app's model (it
-- upserts on user_id+name), so this is a correct reconciliation, not data loss.
-- Without this, the index silently fails to create on a reused DB and the
-- onboarding/course-create upserts then 500 with "no unique constraint matching
-- the ON CONFLICT specification."
delete from public.professors a using public.professors b
  where a.user_id = b.user_id and a.name = b.name and a.ctid < b.ctid;
delete from public.courses a using public.courses b
  where a.user_id = b.user_id and a.name = b.name and a.ctid < b.ctid;
create unique index if not exists professors_user_name_uniq on public.professors (user_id, name);
create unique index if not exists courses_user_name_uniq    on public.courses (user_id, name);
