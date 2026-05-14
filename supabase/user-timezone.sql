alter table public.users
  add column if not exists timezone text not null default 'UTC';
