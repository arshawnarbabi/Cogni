-- Practice test results — run in Supabase SQL editor
create table if not exists public.practice_test_results (
  result_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  test_type text not null check (test_type in ('practice_quiz', 'simulated_exam')),
  topic_filter text,            -- topic name if user filtered to one topic
  question_count integer not null,
  correct_count integer not null default 0,
  score_pct numeric(5,2),       -- 0–100
  missed_topics jsonb default '[]'::jsonb,   -- [{topic, wrong_count}]
  mastery_updates jsonb default '[]'::jsonb, -- [{topic_id, topic_name, old_score, new_score}]
  duration_seconds integer,     -- simulated exam only
  created_at timestamptz not null default now()
);

alter table public.practice_test_results enable row level security;

drop policy if exists "Users manage own practice results" on public.practice_test_results;
create policy "Users manage own practice results"
  on public.practice_test_results
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
