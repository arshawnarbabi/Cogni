# Supabase Setup

> **Quick option:** first enable the **Vault** extension (Dashboard → Database → Extensions → `supabase_vault`), then paste **[`setup.sql`](setup.sql)** into the SQL editor and run it once. It bundles every file below in the correct order and is **idempotent — safe to re-run** to sync an existing database. `setup.sql` is auto-generated from the files below (the source of truth); edit those and regenerate, don't edit `setup.sql` by hand.

Or run these SQL files in the Supabase SQL editor **in this order** for a fresh deployment.

## 1. Core schema
- `schema.sql` — core tables, RLS, and indexes (additional tables follow in sections 3–4)

## 2. Vault (run after enabling the Vault extension in Supabase dashboard)
- `vault-helpers.sql` — API key and named user-secret storage RPCs
- `vault-get.sql` — API key and named user-secret retrieval RPCs

## 3. Storage buckets
- `storage-buckets.sql` — `materials`, `wiki`, `audio` buckets + RLS policies
- `course-files.sql` — `course-files` bucket + `course_files` table

## 4. Additional tables
- `calendar-connections.sql` — Google Calendar integration
- `practice-test-results.sql` — practice quiz and simulated exam scores
- `course-web-suggestions.sql` — web-searched syllabus approval flow
- `user-keys.sql` — generic per-user key store (OpenAI key, etc.)

## 5. Schema migrations (columns added after initial schema)
- `course-icon.sql` — `courses.icon`, `courses.icon_color`
- `essay-content.sql` — `session_log.essay_content`
- `session-inline-card.sql` — `session_messages.inline_card`
- `streak-columns.sql` — `users.study_streak`, `users.last_study_date`
- `inbox-unreadable-status.sql` — adds `unreadable` to inbox status constraint
- `tutor-rate-limit.sql` — `users.daily_message_limit`
- `user-timezone.sql` — `users.timezone`
- `calendar-token-vault-migration.sql` — makes calendar token columns nullable after moving token secrets to Vault

## 6. Functions and indexes
- `fsrs-review-rpc.sql` — `review_card_atomic` function (atomic FSRS + mastery update)
- `rag-functions.sql` — `match_material_chunks` vector similarity search
- `vault-delete.sql` — `delete_user_secret` / `delete_user_api_key` Vault removal RPCs (run after `vault-helpers.sql`)
- `rag-keyword-index.sql` — GIN full-text index on `material_embeddings.content` for the RAG keyword fallback

## 7. One-time data backfills and migrations
- `content-coverage-backfill.sql` — backfills `topics.content_coverage` from flashcard counts (run once)
- `user-keys-vault-migration.sql` — moves any plaintext `user_keys` secrets (e.g. OpenAI keys) into Vault, then removes the plaintext rows (run after `vault-helpers.sql` and `user-keys.sql`)
