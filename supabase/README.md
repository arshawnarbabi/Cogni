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

## 8. Hosted multi-tenant security hardening (required before public sign-up)
- `security-hardening.sql` — REVOKEs the SECURITY-DEFINER vault/`review_card_atomic` RPCs from `anon`/`authenticated` (closes a direct-Data-API key-theft + cross-tenant-write hole), adds explicit `WITH CHECK` to the user-scoped RLS policies, and adds `unique(user_id, name)` to professors/courses. Idempotent. Run last. *(Already included at the end of `setup.sql`.)*

> If you operate Cogni as a single shared deployment with open sign-up, section 8 is **mandatory** — without it any signed-up user can decrypt every user's API keys via the public Data API. (Self-host single-user deployments should still run it.)

## 9. Usage limits / abuse guards (hosted multi-tenant)
- `usage-limits.sql` — per-user daily caps on expensive AI routes (`daily_usage` + `consume_daily_quota`) and a `users.suspended` flag. Idempotent. *(Also included at the end of `setup.sql`.)*

## 10. Production hardening (required before public sign-up)
- `production-hardening.sql` — adds:
  - **Consent/age audit** columns on `users` (`tos_version`, `tos_accepted_at`, `privacy_version`, `age_attested_at`) — written by `/api/auth/signup`.
  - **`app_config`** singleton — runtime kill-switch (`signups_paused`, `ai_disabled`), signup gate (`signup_mode` = open/invite/edu, `allowed_email_domains`). Flip from the SQL editor for an instant change **without a redeploy** (effective within ~10s). Read by `lib/app-config.ts`.
  - **`invite_codes`** + `consume_invite_code()` — single-use codes for `signup_mode='invite'`.
  - **`audit_log`** + `operator_set_suspended()` — append-only security event log + audited operator suspend/unsuspend (used by `/api/operator/*`).
  - **`purge_old_daily_usage()`** — TTL cleanup for the `daily_usage` counter (called weekly by the maintenance cron).
  Idempotent. Run last. *(Already included at the end of `setup.sql`.)*

> Operator toggles after deploy (SQL editor): pause signups → `update app_config set signups_paused=true;` · stop all AI → `update app_config set ai_disabled=true;` · invite-only → `update app_config set signup_mode='invite';` then `insert into invite_codes (code) values ('CODE1');` · .edu-only → `update app_config set signup_mode='edu', allowed_email_domains='{edu}';`
