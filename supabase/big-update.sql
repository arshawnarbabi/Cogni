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

create unique index if not exists assignments_user_course_name_due_uniq
  on public.assignments (user_id, course_id, name, due_date);

-- ── F3: unified mastery model — review_card_atomic takes evidence ────────────
-- (observed level + learning rate, EWMA) instead of an additive delta, so all
-- three mastery writers (tutor / quiz / flashcards) move the score on ONE scale.
-- Also writes the previously-dead confidence column.
drop function if exists public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric
);

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
  p_learning_rate numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topic_id uuid;
begin
  update public.flashcards
  set fsrs_stability = p_fsrs_stability,
      fsrs_difficulty = p_fsrs_difficulty,
      fsrs_reps = p_fsrs_reps,
      fsrs_lapses = p_fsrs_lapses,
      fsrs_state = p_fsrs_state,
      fsrs_last_review = p_fsrs_last_review,
      fsrs_next_review_date = p_fsrs_next_review_date
  where card_id = p_card_id
    and user_id = p_user_id
  returning topic_id into v_topic_id;

  if not found then
    raise exception 'card not found or not owned by user';
  end if;

  if v_topic_id is not null then
    insert into public.topic_mastery (user_id, topic_id, mastery_score, confidence, last_updated)
    values (p_user_id, v_topic_id, greatest(0, least(1, p_observed)), 0.05, now())
    on conflict (user_id, topic_id) do update
      set mastery_score = greatest(0, least(1,
            coalesce(public.topic_mastery.mastery_score, 0)
            + greatest(0, least(1, p_learning_rate))
              * (greatest(0, least(1, p_observed)) - coalesce(public.topic_mastery.mastery_score, 0)))),
          confidence = least(1, coalesce(public.topic_mastery.confidence, 0) + 0.05),
          last_updated = now();

    insert into public.mastery_history (user_id, topic_id, mastery_score)
    select user_id, topic_id, mastery_score
    from public.topic_mastery
    where user_id = p_user_id
      and topic_id = v_topic_id;
  end if;
end;
$$;

-- service_role ONLY (was also granted to authenticated): SECURITY DEFINER +
-- p_user_id parameter meant any logged-in user could replay it against another
-- user's card. Only the server route (service client) calls it.
grant execute on function public.review_card_atomic(
  uuid, uuid, numeric, numeric, integer, integer, text, timestamptz, date, numeric, numeric
) to service_role;

-- PostgREST must see the new unique indexes + function signature before the
-- app's upsert-on-conflict / RPC calls work.
notify pgrst, 'reload schema';

-- Confirm
select
  (select count(*) from pg_indexes where indexname = 'topics_user_course_name_uniq') as topics_idx,
  (select count(*) from pg_indexes where indexname = 'assignments_user_course_name_due_uniq') as assignments_idx;
