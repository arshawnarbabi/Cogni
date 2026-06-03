-- RAG keyword fallback full-text index.
-- Run in the Supabase SQL editor after schema.sql (and rag-functions.sql).
--
-- The keyword fallback in lib/rag.ts runs a plain text search against
-- public.material_embeddings.content, which Postgres executes as
--   content @@ plainto_tsquery('english', ...).
-- Without an index this is a sequential scan that recomputes to_tsvector per
-- row. This GIN index on to_tsvector('english', content) lets the planner use
-- the index, making the keyword fallback scalable for larger material sets.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS is a no-op on re-run. The tsvector
-- config ('english') must match the config pinned in lib/rag.ts so the
-- expression index is usable by the query.

create index if not exists material_embeddings_content_fts
  on public.material_embeddings
  using gin (to_tsvector('english', content));
