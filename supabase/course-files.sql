-- ============================================================
-- COGNI — Course File Storage
-- Run in Supabase SQL editor after schema.sql
-- ============================================================

-- Table: tracks files attached to a course
create table if not exists public.course_files (
  file_id     uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(course_id) on delete cascade,
  name        text not null,          -- original filename
  mime_type   text not null,
  size_bytes  bigint not null,
  storage_path text not null,         -- path in Supabase Storage bucket
  created_at  timestamptz not null default now()
);

-- RLS
alter table public.course_files enable row level security;

drop policy if exists "owner_all" on public.course_files;
create policy "owner_all" on public.course_files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Index for fast per-course lookups
create index if not exists course_files_course_id_idx on public.course_files (course_id);

-- ============================================================
-- Storage bucket (run via Supabase dashboard or this SQL)
-- ============================================================
-- In the Supabase dashboard → Storage → New bucket:
--   Name: course-files
--   Public: OFF (private)
-- Then add RLS policies on storage.objects:

insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do nothing;

-- Allow authenticated users to upload/read/delete their own files
drop policy if exists "owner_upload" on storage.objects;
create policy "owner_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'course-files' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner_read" on storage.objects;
create policy "owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'course-files' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner_delete" on storage.objects;
create policy "owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'course-files' and auth.uid()::text = (storage.foldername(name))[1]);
