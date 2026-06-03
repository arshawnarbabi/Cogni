-- Storage buckets required by Cogni.
-- Run in Supabase SQL editor after schema.sql.
-- The course-files bucket is created separately in course-files.sql.

-- ── materials ─────────────────────────────────────────────────────────────────
-- Uploaded PDFs, text files, and syllabuses.
-- All paths are stored as {user_id}/{filename} in the materials table.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

drop policy if exists "materials: owner upload" on storage.objects;
create policy "materials: owner upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'materials' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "materials: owner read" on storage.objects;
create policy "materials: owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'materials' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "materials: owner delete" on storage.objects;
create policy "materials: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'materials' and auth.uid()::text = (storage.foldername(name))[1]);

-- ── wiki ──────────────────────────────────────────────────────────────────────
-- Markdown knowledge files (learning profile, professor profiles).
-- Paths: {user_id}/{filename}.md
insert into storage.buckets (id, name, public)
values ('wiki', 'wiki', false)
on conflict (id) do nothing;

drop policy if exists "wiki: owner upload" on storage.objects;
create policy "wiki: owner upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wiki' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "wiki: owner read" on storage.objects;
create policy "wiki: owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'wiki' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "wiki: owner delete" on storage.objects;
create policy "wiki: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wiki' and auth.uid()::text = (storage.foldername(name))[1]);

-- ── audio ─────────────────────────────────────────────────────────────────────
-- Generated audio overview MP3s (TTS).
-- Paths: {user_id}/{filename}.mp3
insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do nothing;

drop policy if exists "audio: owner upload" on storage.objects;
create policy "audio: owner upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "audio: owner read" on storage.objects;
create policy "audio: owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "audio: owner delete" on storage.objects;
create policy "audio: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and auth.uid()::text = (storage.foldername(name))[1]);
