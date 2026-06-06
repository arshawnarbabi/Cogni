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

-- PostgREST must see the new unique indexes before upsert-on-conflict works.
notify pgrst, 'reload schema';

-- Confirm
select
  (select count(*) from pg_indexes where indexname = 'topics_user_course_name_uniq') as topics_idx,
  (select count(*) from pg_indexes where indexname = 'assignments_user_course_name_due_uniq') as assignments_idx;
