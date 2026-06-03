-- ============================================================
-- COGNI — FULL DATABASE SCHEMA
-- Run this entire file in the Supabase SQL editor
-- Idempotent: safe to run more than once (create-if-not-exists + drop/create policies).
-- ============================================================

-- Enable pgvector for RAG embeddings
create extension if not exists vector;

-- ============================================================
-- TABLES
-- ============================================================

-- Users (extends Supabase auth.users)
create table if not exists public.users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  university text,
  major text,
  year text,
  session_length_preference integer not null default 45, -- minutes: 25, 45, or 90
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

-- Professors (independent entities, persist across semesters)
create table if not exists public.professors (
  professor_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  name text not null,
  department text,
  profile_status text not null default 'active' check (profile_status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

-- Courses
create table if not exists public.courses (
  course_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  professor_id uuid references public.professors(professor_id) on delete set null,
  name text not null,
  department text,
  course_type text check (course_type in ('quantitative', 'conceptual_science', 'humanities', 'social_science', 'language', 'professional')),
  semester text,
  active_status text not null default 'active' check (active_status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

-- Topics (created from syllabus, core of the four-number framework)
create table if not exists public.topics (
  topic_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  name text not null,
  syllabus_order integer,
  content_coverage numeric(3,2) not null default 0 check (content_coverage >= 0 and content_coverage <= 1),
  professor_weight numeric(3,2) not null default 0.5 check (professor_weight >= 0 and professor_weight <= 1),
  -- Topic-level FSRS fields
  fsrs_stability numeric,
  fsrs_difficulty numeric,
  fsrs_next_review_date date,
  created_at timestamptz not null default now()
);

-- Topic Mastery (mastery score per topic per student)
create table if not exists public.topic_mastery (
  mastery_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  topic_id uuid not null references public.topics(topic_id) on delete cascade,
  mastery_score numeric(3,2) check (mastery_score >= 0 and mastery_score <= 1),
  confidence numeric(3,2) check (confidence >= 0 and confidence <= 1),
  last_updated timestamptz not null default now(),
  unique(user_id, topic_id)
);

-- Flashcards (card-level FSRS)
create table if not exists public.flashcards (
  card_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  topic_id uuid references public.topics(topic_id) on delete set null,
  front text not null,
  back text not null,
  hint text,
  -- Card-level FSRS fields
  fsrs_stability numeric not null default 0,
  fsrs_difficulty numeric not null default 0,
  fsrs_retrievability numeric,
  fsrs_last_review timestamptz,
  fsrs_next_review_date date not null default current_date,
  fsrs_reps integer not null default 0,
  fsrs_lapses integer not null default 0,
  fsrs_state text not null default 'new' check (fsrs_state in ('new', 'learning', 'review', 'relearning')),
  created_at timestamptz not null default now()
);

-- Exams
create table if not exists public.exams (
  exam_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  date date not null,
  grade_weight numeric(5,2), -- percentage of final grade
  topics_covered uuid[], -- array of topic_ids
  student_score numeric(5,2), -- nullable, populated when graded exam uploaded
  duration_minutes integer, -- from syllabus, used for simulated exam timer
  created_at timestamptz not null default now()
);

-- Assignments / Homework
create table if not exists public.assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  name text,
  due_date timestamptz not null,
  type text, -- homework, quiz, project, etc.
  completion_status text not null default 'pending' check (completion_status in ('pending', 'complete', 'late')),
  created_at timestamptz not null default now()
);

-- Materials (uploaded files and typed content)
create table if not exists public.materials (
  material_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid references public.courses(course_id) on delete set null,
  tier integer check (tier between 1 and 4),
  file_type text, -- pdf, txt, image, typed
  storage_path text, -- path in Supabase Storage materials bucket
  filename text,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  uploaded_at timestamptz not null default now(),
  topic_ids uuid[] -- populated after processing
);

-- Inbox Items (raw classification queue)
create table if not exists public.inbox_items (
  inbox_item_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  material_id uuid references public.materials(material_id) on delete cascade,
  classification_status text not null default 'pending' check (classification_status in ('pending', 'classified', 'unassigned', 'failed')),
  confidence_score numeric(3,2) check (confidence_score >= 0 and confidence_score <= 1),
  course_id uuid references public.courses(course_id) on delete set null,
  tier integer check (tier between 1 and 4),
  nudge_pending boolean not null default false,
  created_at timestamptz not null default now()
);

-- Tutor Session Log
create table if not exists public.session_log (
  session_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  course_id uuid not null references public.courses(course_id) on delete cascade,
  name text, -- auto-generated by Haiku after first exchange
  mode text not null default 'answer' check (mode in ('answer', 'teach', 'focus', 'essay')),
  topics_discussed uuid[], -- array of topic_ids
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tutor Messages (per session)
create table if not exists public.session_messages (
  message_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.session_log(session_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Nudges
create table if not exists public.nudges (
  nudge_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  type text not null, -- homework_completion, material_gap, pending_classification, missing_api_key, missing_syllabus, calendar_conflict, upload_content
  tier text not null check (tier in ('critical', 'standard', 'recurring')),
  content text not null,
  course_id uuid references public.courses(course_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'snoozed')),
  snoozed_until timestamptz, -- for standard nudges dismissed with 7-day cooldown
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Wiki Versions (snapshot table for recovery)
create table if not exists public.wiki_versions (
  version_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  file_path text not null, -- e.g. 'learning_profile.md', 'professor_abc123.md'
  content text not null,
  triggered_by_agent text, -- inbox, profiler, tutor, etc.
  created_at timestamptz not null default now()
);

-- Study Plan (daily generated plan)
create table if not exists public.study_plan (
  plan_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  plan_date date not null,
  tasks jsonb not null default '[]', -- array of task objects with type, course_id, topic_ids, duration_minutes, order
  generated_at timestamptz not null default now(),
  unique(user_id, plan_date)
);

-- Mastery History (for 30-day trend lines in Progress tab)
create table if not exists public.mastery_history (
  history_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  topic_id uuid not null references public.topics(topic_id) on delete cascade,
  mastery_score numeric(3,2) not null,
  recorded_at timestamptz not null default now()
);

-- Vector Embeddings (RAG via pgvector)
create table if not exists public.material_embeddings (
  embedding_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  material_id uuid not null references public.materials(material_id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536), -- text-embedding-3-small dimension
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.users enable row level security;
alter table public.professors enable row level security;
alter table public.courses enable row level security;
alter table public.topics enable row level security;
alter table public.topic_mastery enable row level security;
alter table public.flashcards enable row level security;
alter table public.exams enable row level security;
alter table public.assignments enable row level security;
alter table public.materials enable row level security;
alter table public.inbox_items enable row level security;
alter table public.session_log enable row level security;
alter table public.session_messages enable row level security;
alter table public.nudges enable row level security;
alter table public.wiki_versions enable row level security;
alter table public.study_plan enable row level security;
alter table public.mastery_history enable row level security;
alter table public.material_embeddings enable row level security;

-- ============================================================
-- RLS POLICIES (all scoped to auth.uid())
-- drop-then-create so the file is re-runnable (CREATE POLICY has no IF NOT EXISTS)
-- ============================================================

-- Users
drop policy if exists "users: own row only" on public.users;
create policy "users: own row only" on public.users
  for all using (auth.uid() = user_id);

-- Professors
drop policy if exists "professors: own rows only" on public.professors;
create policy "professors: own rows only" on public.professors
  for all using (auth.uid() = user_id);

-- Courses
drop policy if exists "courses: own rows only" on public.courses;
create policy "courses: own rows only" on public.courses
  for all using (auth.uid() = user_id);

-- Topics
drop policy if exists "topics: own rows only" on public.topics;
create policy "topics: own rows only" on public.topics
  for all using (auth.uid() = user_id);

-- Topic Mastery
drop policy if exists "topic_mastery: own rows only" on public.topic_mastery;
create policy "topic_mastery: own rows only" on public.topic_mastery
  for all using (auth.uid() = user_id);

-- Flashcards
drop policy if exists "flashcards: own rows only" on public.flashcards;
create policy "flashcards: own rows only" on public.flashcards
  for all using (auth.uid() = user_id);

-- Exams
drop policy if exists "exams: own rows only" on public.exams;
create policy "exams: own rows only" on public.exams
  for all using (auth.uid() = user_id);

-- Assignments
drop policy if exists "assignments: own rows only" on public.assignments;
create policy "assignments: own rows only" on public.assignments
  for all using (auth.uid() = user_id);

-- Materials
drop policy if exists "materials: own rows only" on public.materials;
create policy "materials: own rows only" on public.materials
  for all using (auth.uid() = user_id);

-- Inbox Items
drop policy if exists "inbox_items: own rows only" on public.inbox_items;
create policy "inbox_items: own rows only" on public.inbox_items
  for all using (auth.uid() = user_id);

-- Session Log
drop policy if exists "session_log: own rows only" on public.session_log;
create policy "session_log: own rows only" on public.session_log
  for all using (auth.uid() = user_id);

-- Session Messages
drop policy if exists "session_messages: own rows only" on public.session_messages;
create policy "session_messages: own rows only" on public.session_messages
  for all using (auth.uid() = user_id);

-- Nudges
drop policy if exists "nudges: own rows only" on public.nudges;
create policy "nudges: own rows only" on public.nudges
  for all using (auth.uid() = user_id);

-- Wiki Versions
drop policy if exists "wiki_versions: own rows only" on public.wiki_versions;
create policy "wiki_versions: own rows only" on public.wiki_versions
  for all using (auth.uid() = user_id);

-- Study Plan
drop policy if exists "study_plan: own rows only" on public.study_plan;
create policy "study_plan: own rows only" on public.study_plan
  for all using (auth.uid() = user_id);

-- Mastery History
drop policy if exists "mastery_history: own rows only" on public.mastery_history;
create policy "mastery_history: own rows only" on public.mastery_history
  for all using (auth.uid() = user_id);

-- Material Embeddings
drop policy if exists "material_embeddings: own rows only" on public.material_embeddings;
create policy "material_embeddings: own rows only" on public.material_embeddings
  for all using (auth.uid() = user_id);

-- ============================================================
-- INDEXES (performance) — named + if-not-exists so re-runs are safe
-- ============================================================

create index if not exists idx_topics_course_id on public.topics(course_id);
create index if not exists idx_topic_mastery_user_topic on public.topic_mastery(user_id, topic_id);
create index if not exists idx_flashcards_user_course on public.flashcards(user_id, course_id);
create index if not exists idx_flashcards_due on public.flashcards(fsrs_next_review_date);
create index if not exists idx_exams_course_date on public.exams(course_id, date);
create index if not exists idx_assignments_user_due on public.assignments(user_id, due_date);
create index if not exists idx_nudges_user_status on public.nudges(user_id, status);
create index if not exists idx_session_log_user_course on public.session_log(user_id, course_id);
create index if not exists idx_mastery_history_user_topic_recorded on public.mastery_history(user_id, topic_id, recorded_at);
create index if not exists idx_material_embeddings_embedding on public.material_embeddings using ivfflat (embedding vector_cosine_ops);
