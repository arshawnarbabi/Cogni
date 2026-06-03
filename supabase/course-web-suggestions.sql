-- Stores web-searched syllabus/course content surfaced to the user for approval.
-- Fires automatically on course creation when no syllabus is uploaded.

create table if not exists public.course_web_suggestions (
  id           uuid        primary key default gen_random_uuid(),
  course_id    uuid        not null references public.courses(course_id) on delete cascade,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  title        text,
  url          text,
  content      text        not null,
  status       text        not null default 'pending'
               check (status in ('pending', 'approved', 'dismissed')),
  created_at   timestamptz not null default now()
);

alter table public.course_web_suggestions enable row level security;

drop policy if exists "Users manage their own web suggestions" on public.course_web_suggestions;
create policy "Users manage their own web suggestions"
  on public.course_web_suggestions
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
