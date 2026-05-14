# Cogni Execution Plan

Purpose: Turn `DEEP_SCAN_FINDINGS.md` into an implementation plan.  
Scope: Planning only. Do not change application code as part of this step.  
Constraint: This file uses text, architectural pseudocode, and structural instructions only. It avoids concrete multi-line programming code.

## Guiding Principles

1. Fix tenant boundaries first. Most serious risks come from service-role Supabase calls that bypass RLS, so every service-role path must prove ownership before reading, writing, signing, or deleting.
2. Centralize repeated checks. Add small server-side guard/helper patterns rather than scattering one-off ownership queries everywhere.
3. Keep user-facing behavior stable while tightening internals. Preserve current product flows unless the current behavior is unsafe or incorrect.
4. Make data migrations idempotent. All Supabase SQL changes should be safe to run more than once.
5. Add focused regression tests after each risk cluster. Do not wait until the end to test everything.
6. Avoid silent failures in service-role writes. If a mutation affects user-visible state, handle and report errors.

## Recommended Fix Order

1. Tenant isolation and service-role guardrails.
2. Session/tutor privacy and course ownership.
3. Secret/token storage.
4. Dependency/security rendering updates.
5. Mastery, scheduler, and date correctness.
6. Upload/storage consistency and cleanup.
7. Schema mismatches and RAG performance.
8. Lint/type hygiene and final verification.

This order matters because later functional fixes depend on trusted user/course/session ownership.

## Phase 1: Tenant Isolation Guardrails

### Shared Ownership Helpers

Create a small server-only authorization layer near the Supabase server utilities or in a new auth/data-access module.

It should provide guard-style helpers for:

- Current authenticated user lookup.
- Course ownership by `courseId`.
- Professor ownership by `professorId`.
- Tutor session ownership by `sessionId`.
- Material ownership by `materialId`.
- Inbox item ownership by `itemId`.
- Assignment ownership by `assignmentId`.
- Course file ownership by `fileId`.

Structural behavior:

- Authenticate the request user.
- Query the resource with both resource ID and `user_id`.
- Return the owned row when present.
- Return a not-found/unauthorized response when absent.
- Routes should pass the owned row forward instead of reusing untrusted IDs.

Acceptance criteria:

- No route should use a client-supplied `courseId`, `sessionId`, `professorId`, `materialId`, or `fileId` in a service-role query before ownership is established.
- Security-sensitive "not found" responses should avoid revealing whether another user's resource exists.

### Findings Covered

This phase directly addresses findings 1, 2, 3, 4, 5, 6, 15, 22, 27, 28, and 29.

## Phase 2: Course File API Fixes

### Files

- `lib/course-files.ts`
- `app/api/courses/files/route.ts`

### Plan

Change course-file helpers so they always accept `userId` for list, upload, signed URL creation, and download decisions.

For listing:

- Authenticate user.
- Verify the course belongs to the user.
- List only `course_files` rows matching both `course_id` and `user_id`.
- Create signed URLs only for rows returned from that scoped query.

For upload:

- Authenticate user.
- Verify the course belongs to the user before reading the uploaded file into memory.
- Sanitize the stored filename.
- Store under the current user's storage prefix.
- Insert the record with the verified course ID.

For signed URL:

- Do not create a signed URL from an arbitrary path.
- Resolve the row by `file_id`, `course_id`, and `user_id`, then sign the row's known storage path.

For helper cleanup:

- Update `getMyFiles()` so it passes `userId` into the scoped listing function.
- Keep `deleteCourseFile()` tenant-scoped as it already mostly is.

Regression checks:

- User A cannot list User B's course files by course UUID.
- User A cannot upload to User B's course UUID.
- User A cannot get a signed URL for User B's file.
- Existing own-course upload/list/delete still works.

## Phase 3: Tutor Session and Course Boundary Fixes

### Files

- `app/api/agents/tutor/route.ts`
- `lib/agents/tutor.ts`
- `app/api/agents/tutor/sessions/route.ts`

### Plan

For tutor GET:

- Authenticate user.
- Verify `sessionId` belongs to user.
- Fetch messages only after session ownership is verified.
- Consider changing `getSessionMessages()` to require `userId` and query through a session join or a pre-verified session row.

For tutor POST:

- Authenticate user.
- Verify `courseId` belongs to user before key lookup, session creation, RAG retrieval, topic lookup, or message save.
- If `existingSessionId` is supplied, verify that session belongs to the same user and same course.
- If `existingSessionId` is invalid, return not found instead of silently creating or writing elsewhere.
- If no session is supplied, create or reuse a session only after course ownership is confirmed.
- Ensure `createSession()` and `getOrCreateSession()` cannot be called with an unverified course ID from routes.

For session helpers:

- Make session helper names reflect whether they are raw data helpers or ownership-enforcing helpers.
- Prefer requiring `userId` in functions that read or mutate session messages.

Regression checks:

- User A cannot read User B's session messages.
- User A cannot append to User B's session.
- User A cannot start a tutor session for User B's course.
- Normal tutor streaming still persists user and assistant messages.
- Inline flashcards, quizzes, essay chips, and session naming still work.

## Phase 4: Quiz, Simulated Exam, and Mastery Course Boundary Fixes

### Files

- `app/api/agents/practice-quiz/route.ts`
- `app/api/agents/practice-quiz/grade/route.ts`
- `app/api/agents/simulated-exam/route.ts`
- `lib/agents/practice-quiz.ts`
- `app/api/agents/tutor/route.ts`

### Plan

Add course ownership validation at route entry for practice quiz, quiz grading, and simulated exam generation.

Then make lower-level quiz functions tenant-defensive:

- Topic queries should include both `course_id` and `user_id`.
- Exam queries should include both `course_id` and `user_id`.
- Practice result inserts should only use a verified course ID.
- Mastery updates should only target topics owned by the same user and course.

For tutor `grade_answer`:

- Resolve topic by verified course and user.
- Update `topic_mastery` through the shared mastery update path described in Phase 9.
- Write `mastery_history` for tutor-driven mastery changes so progress trends reflect them.

Regression checks:

- User A cannot generate a quiz from User B's course UUID.
- User A cannot grade a quiz into User B's course UUID.
- Mastery rows created from quiz grading always reference topics owned by that user.
- Tutor verification grading updates current user's topic only.

## Phase 5: Inbox Assignment Boundary Fixes

### Files

- `app/api/inbox/items/[itemId]/route.ts`
- `app/api/inbox/upload/route.ts`
- `lib/agents/inbox.ts`

### Plan

For manual inbox assignment:

- Verify inbox item belongs to the user.
- Verify target course belongs to the same user.
- Only then update `inbox_items` and `materials`.
- Include `user_id` in update filters even after verification for defense in depth.

For direct upload with `courseIdHint`:

- Treat `courseIdHint` as untrusted.
- Verify the course belongs to the user before passing it into `classifyMaterial`.
- If invalid, reject the request or ignore the hint and fall back to normal classification.

For `classifyMaterial()`:

- When `forceCourseId` is present, confirm it belongs to `userId` inside the function as well.
- Include `user_id` filters in material/inbox update operations.

Regression checks:

- User A cannot assign inbox items or uploads to User B's course.
- Valid direct-to-course uploads still skip classification as intended.
- Unassigned, failed, and unreadable inbox recovery still works.

## Phase 6: Cron Secret Hardening

### Files

- `app/api/agents/scheduler/route.ts`
- `app/api/agents/nudge/route.ts`
- `.env.example`
- `README.md`

### Plan

Centralize cron authorization in a helper.

Required behavior:

- If `CRON_SECRET` is missing or blank, reject cron GET requests.
- Compare the Authorization header against the configured secret only after confirming the configured secret exists.
- Return unauthorized for any mismatch.
- Keep authenticated POST rerun behavior separate from cron GET behavior.

Documentation:

- Add `CRON_SECRET` to `.env.example`.
- Clarify that Vercel may inject it for Vercel Cron, but self-hosted/non-Vercel deployments must set it.
- Clarify that local manual testing should use authenticated POST routes or an explicitly configured local cron secret.

Regression checks:

- Missing `CRON_SECRET` never accepts `Bearer undefined`.
- Correct secret runs cron.
- Incorrect secret fails.
- Authenticated user POST scheduler route still works.

## Phase 7: Secrets and Token Storage

### Anthropic and OpenAI API Keys

Files:

- `app/api/settings/api-key/route.ts`
- `app/api/user/keys/route.ts`
- `lib/vault.ts`
- `lib/user-keys.ts`
- `supabase/vault-helpers.sql`
- `supabase/vault-get.sql`
- `supabase/user-keys.sql`
- Settings UI files.

Plan:

- Decide whether OpenAI should use Supabase Vault like Anthropic. Based on README, it should.
- Generalize Vault RPCs to support named per-user secrets, such as `anthropic_key` and `openai_key`, instead of only `api_key_userId`.
- Keep the secret name deterministic and scoped by user and key name.
- Update OpenAI key storage and retrieval to use Vault.
- Migrate existing `user_keys` OpenAI values into Vault through a one-time idempotent migration or a temporary server-side migration script.
- After migration, stop storing secret values in `public.user_keys`; keep only metadata if needed, such as key name, configured flag, updated timestamp, and preview suffix.
- Avoid returning raw key values to the browser. Return only set/not-set and preview.

Acceptance criteria:

- README claim becomes true: Anthropic and OpenAI keys are stored through Vault.
- No API route returns full key values.
- Existing users with OpenAI keys keep working after migration.
- Audio overview and RAG retrieval still find the OpenAI key.

### Google Calendar OAuth Tokens

Files:

- `app/api/calendar/callback/route.ts`
- `lib/calendar.ts`
- `supabase/calendar-connections.sql`

Plan:

- Store Google access/refresh tokens in Vault or another encrypted secret storage.
- Keep `calendar_connections` as metadata: user ID, provider, expiry, calendar ID, connection status, timestamps, and a secret reference if useful.
- On callback, write tokens to Vault and metadata to `calendar_connections`.
- On token refresh, update Vault with the new access token and update expiry metadata.
- On disconnect/account deletion, remove or overwrite the Vault secrets and delete metadata.

Acceptance criteria:

- Calendar still connects, refreshes, creates the Cogni calendar, writes study blocks, and disconnects.
- Refresh token no longer lives as plaintext in a normal public schema table.

## Phase 8: Dependency and Mermaid Security Updates

### Dependencies

Files:

- `package.json`
- `package-lock.json`

Plan:

- Update `next` to a patched release satisfying the audit.
- Update `@anthropic-ai/sdk` to a patched release and verify any breaking changes in imports, model parameters, streaming event shapes, and tool definitions.
- Update transitive vulnerable packages through normal dependency updates where possible.
- Update `mermaid` to a patched release.
- Re-run audit after updates.

Acceptance criteria:

- Audit has no high vulnerabilities and no relevant moderate vulnerabilities for reachable app paths.
- Build and typecheck pass.
- Tutor streaming and web search still work after Anthropic SDK update.

### Mermaid Rendering

Files:

- `app/(shell)/tutor/_client.tsx`

Plan:

- Keep Mermaid support only after dependency update.
- Add a safety wrapper around Mermaid rendering:
  - Limit diagram source length.
  - Disable risky Mermaid features where the library supports security settings.
  - Render with strict security mode.
  - Avoid injecting unsanitized SVG if possible.
  - If direct SVG insertion remains necessary, sanitize the SVG output with a maintained sanitizer before inserting.
- Add graceful fallback for parse/render errors.

Acceptance criteria:

- Normal Mermaid flowcharts render.
- Oversized or invalid diagrams do not freeze the UI.
- Audit no longer flags the installed Mermaid version for known sanitization issues.

## Phase 9: Mastery System Correctness

### Shared Mastery Update Path

Files:

- `app/api/cards/review/route.ts`
- `supabase/fsrs-review-rpc.sql`
- `lib/agents/practice-quiz.ts`
- `app/api/agents/tutor/route.ts`
- `lib/agents/scheduler.ts`

Plan:

Create one conceptual mastery update policy:

- Every topic mastery change must upsert `topic_mastery` if missing.
- Every meaningful mastery change should write `mastery_history`.
- Every topic update must verify the topic belongs to the user.
- All mastery scores must clamp from 0 to 1.
- FSRS card scheduling and topic mastery updates must remain atomic for flashcard review.

For flashcard review:

- Update the RPC so a missing `topic_mastery` row is created instead of silently doing nothing.
- Preserve the current atomic card update plus mastery update behavior.
- Add history insert if the product expects Progress charts to reflect flashcard reviews.

For quiz grading:

- Keep the current blended update model.
- Ensure topic lookup is scoped by both course and user.
- Ensure history writes happen only after successful mastery upsert.

For tutor `grade_answer`:

- Stop using a standalone mastery update.
- Reuse the shared mastery updater and write history.
- Ensure the score is clamped and topic matching cannot cross courses/users.

Scheduler behavior:

- Decide how to treat high-priority topics with zero due flashcards.
- If a topic has no due cards but low mastery and high professor weight, the task should be a learning/practice task, not a flashcard review task with `card_count` zero.
- If the UI only supports flashcard review tasks, scheduler should exclude zero-card review tasks until cards exist.

Regression checks:

- Reviewing a card with an existing mastery row updates card FSRS, mastery, and history.
- Reviewing a card without a mastery row creates mastery and updates it.
- Quiz grading updates mastery and history for owned topics only.
- Tutor verification grading updates mastery and history for owned topics only.
- Scheduler never produces a misleading flashcard review task with zero reviewable cards unless the UI explicitly supports that state.

## Phase 10: Scheduler, Dates, Timezone, and Calendar Correctness

### User Timezone Model

Files:

- `supabase/schema.sql` or a new migration.
- Onboarding/settings UI.
- `lib/agents/scheduler.ts`
- `lib/calendar.ts`
- `lib/agents/nudge.ts`
- `app/(shell)/today/page.tsx`
- `app/api/user/streak/route.ts`
- Review page and due-card queries.

Plan:

- Add a user timezone preference. Default it from the browser during onboarding or first settings load.
- Store a valid IANA timezone string, such as the user's browser timezone.
- Add shared date utilities:
  - Get the user's local date string.
  - Convert a local day start/end to UTC instants for database queries.
  - Build 8am-10pm local study windows for Calendar.
  - Compute yesterday/tomorrow in the user's timezone.

Replace server UTC date usage in:

- Today's scheduler generation.
- Due-card queries.
- Streak update.
- Nudge checks.
- Upcoming preview window.
- Calendar study block placement.

Acceptance criteria:

- A user in America/Los_Angeles sees correct "today" near UTC midnight.
- Study blocks are written into 8am-10pm in the user's timezone.
- Streaks advance by the user's local day, not Vercel's server day.
- Due cards are selected for the user's local date.

### Upcoming Preview Homework Grouping

Files:

- `lib/agents/scheduler.ts`

Plan:

- Normalize each assignment `due_date` to the user's local date string before grouping.
- Query assignments using UTC bounds derived from each user's local preview window.
- Group by normalized date, not by raw timestamp.

Acceptance criteria:

- Assignments due at any time on a local date appear in that date's preview.
- Existing same-day homework behavior remains correct.

## Phase 11: Professor Profiling and Onboarding Robustness

### Professor Ownership

Files:

- `app/api/courses/create/route.ts`
- `app/api/onboarding/complete/route.ts`
- Professor search route and UI if needed.

Plan:

- If an existing professor ID is supplied, verify it belongs to the authenticated user before using it.
- If it does not belong to the user, reject it.
- Do the same during onboarding completion.

Acceptance criteria:

- User A cannot create a course linked to User B's professor.
- Existing own-professor reuse still works.

### Onboarding Transactionality and Idempotency

Files:

- `app/api/onboarding/complete/route.ts`
- Possibly a new Supabase RPC migration.

Plan:

- Move the core onboarding write sequence into an idempotent transaction.
- Upsert or find the user row rather than failing permanently on duplicate user insert.
- Create or reuse professors and courses deterministically within the request.
- Insert materials only for verified uploaded storage paths under the current user's prefix.
- Run profiler after the core transaction commits.
- Track profiler status separately so onboarding can complete even if AI extraction fails.

Acceptance criteria:

- Retrying onboarding after a mid-flow failure repairs or continues the setup.
- User is not left blocked by a duplicate user row.
- Partial profiler failures do not corrupt the course list.

## Phase 12: Upload, File Validation, and Orphan Cleanup

### Upload Flow Cleanup

Files:

- `app/api/inbox/upload/route.ts`
- `app/api/onboarding/upload-syllabus/route.ts`
- `app/api/courses/create/route.ts`

Plan:

- Track each step that creates storage or database state.
- If a later step fails, clean up earlier storage objects and partial DB rows where safe.
- For onboarding temporary syllabus uploads, add a cleanup mechanism for abandoned uploads.
- Make duplicate cleanup remove both DB row and storage file when replacing stuck material.

Acceptance criteria:

- Failed inbox upload does not leave an invisible storage object.
- Failed inbox item insert removes the material row and uploaded object.
- Abandoned onboarding uploads are either reused by completion or cleaned later.

### File Validation

Plan:

- Keep extension allowlists as a first pass.
- Add content sniffing for supported types:
  - PDF should have a PDF signature.
  - Common image types should match expected binary signatures.
  - Text/Markdown should decode as text within limits.
  - DOCX, where supported, should match ZIP-based Office document expectations.
- Enforce MIME consistency where practical.
- Reject unsupported or mismatched content before storage or AI processing.

Acceptance criteria:

- Renamed unsupported binary files are rejected.
- Valid PDFs, text, Markdown, images, and DOCX files still pass where supported.
- Parser failures are user-visible and retryable.

### Tutor Attachments

Files:

- `app/api/agents/tutor/route.ts`
- Tutor client upload logic if needed.

Plan:

- Add server-side limits for attachment count.
- Add per-attachment and total request payload limits.
- Restrict image media types to those supported by Anthropic.
- Restrict text attachment length.
- Return clear validation errors before calling Anthropic.

Acceptance criteria:

- Oversized attachment payloads fail fast.
- Valid small image/text attachments still reach the tutor.

## Phase 13: Account Deletion and Storage Cleanup

Files:

- `app/api/settings/account/route.ts`
- `app/api/settings/reset/route.ts`

Plan:

- Clean storage before deleting the user row, or preserve enough metadata to clean after deletion.
- Implement paginated storage listing instead of a fixed 200-item limit.
- Recursively handle nested paths or explicitly list all known prefixes.
- Include `course-files` cleanup in both account deletion and dev reset paths.
- Remove or clear Vault secrets for Anthropic, OpenAI, and Calendar tokens.
- Treat cleanup failures as reportable errors or record a cleanup-needed state.

Acceptance criteria:

- Accounts with more than 200 storage objects are fully cleaned.
- Nested syllabus/course file paths are removed.
- Vault secrets do not remain after account deletion.

## Phase 14: RAG and Schema Fixes

### RAG Keyword Index

Files:

- `supabase/schema.sql`
- `supabase/rag-functions.sql` or a new migration.

Plan:

- Add an index suitable for full-text search on material chunk content.
- Consider a generated search vector column if Supabase/Postgres setup supports it cleanly.
- Keep the fallback scoped by user and course.

Acceptance criteria:

- Keyword fallback remains correct and becomes scalable for larger material sets.
- Vector search still works when OpenAI key is configured.

### Tenant-Defensive Embedding Replacement

Files:

- `lib/rag.ts`

Plan:

- Before deleting embeddings, verify the material belongs to `userId`.
- Delete by both `material_id` and `user_id`.
- Insert embeddings only after verified material ownership.

Acceptance criteria:

- A bad caller cannot delete another user's embeddings by material ID.

### Simulated Exam Schema Mismatch

Files:

- `supabase/schema.sql`
- New migration file.
- `lib/agents/practice-quiz.ts`

Plan:

- Decide whether `question_count` belongs on `exams`.
- If yes, add an idempotent migration and update setup docs ordering.
- If no, remove the select and keep default/derived question counts.
- Keep generated exam size bounded regardless of database value.

Acceptance criteria:

- Simulated exam generation no longer selects a missing column.
- Existing deployments can migrate cleanly.

## Phase 15: Calendar Scheduling Cleanup

Files:

- `lib/calendar.ts`
- Calendar connection routes.

Plan:

- Use user timezone utilities from Phase 10.
- When writing events, set dateTime values with the correct timezone semantics.
- Avoid deleting all Cogni events for the wrong UTC day.
- Treat failed event creation as observable, not silently ignored.
- Keep Calendar cleanup on disconnect best-effort, but log enough context for debugging.

Acceptance criteria:

- Calendar blocks land on the user's intended day and time window.
- Re-running scheduler replaces only that user's Cogni blocks for the intended local date.

## Phase 16: Build and Font Reliability

Files:

- `app/layout.tsx`
- Font setup files if present.
- `next.config.ts` if needed.

Plan:

- Decide whether builds should be network-independent.
- If yes, self-host fonts or replace `next/font/google` with local font assets.
- If no, document that CI/build environments require network access to Google Fonts.

Acceptance criteria:

- Production build works in the intended CI/deploy environment.
- The reason for any required network access is documented.

## Phase 17: Lint and Type Hygiene

### Lint Failures

Files listed by `npm run lint`.

Plan:

- Move dynamic icon component resolution out of render paths or render through stable component wrappers.
- Replace synchronous effect state synchronization with derived state, keyed state initialization, or event-driven updates where appropriate.
- Replace explicit `any` in page shaping with local types for Supabase result shapes.
- Escape user-facing apostrophes in JSX text.
- Add missing image alt text or mark decorative images with empty alt text.
- Fix the `QuizSession` callback dependency issue without causing unwanted quiz reset loops.

Acceptance criteria:

- `npm run lint` passes.
- `npx tsc --noEmit` still passes.
- UI behavior remains unchanged.

### Type Strictness

Files:

- `tsconfig.json`
- Supabase client typing setup if added.

Plan:

- Decide whether to keep `allowJs`.
- Consider introducing generated Supabase database types.
- Replace untyped service-role client usage incrementally with typed helpers.
- Revisit `skipLibCheck` only after dependency updates are stable.

Acceptance criteria:

- Data-access helpers reduce the need for broad `any`.
- Future route ownership mistakes become easier to catch in review.

## Phase 18: Service-Role Error Handling

Files:

- Routes and agents listed in finding 30.

Plan:

- For user-facing mutations, check the result of every update/insert/delete.
- Return a structured error when the mutation fails.
- For background jobs, log contextual errors and continue only when the failed step is truly optional.
- Avoid reporting success before required writes succeed.

Acceptance criteria:

- Settings changes report failure if the DB update fails.
- Inbox assignment/retry reports failure if material or inbox updates fail.
- Background optional jobs are clearly marked as optional in logs.

## Phase 19: Mock Agent Toggle Safety

Files:

- `.env.example`
- `app/api/agents/practice-quiz/route.ts`
- `app/api/agents/simulated-exam/route.ts`

Plan:

- Replace public mock toggle usage in server routes with a server-only env variable.
- Optionally require development mode as an additional condition.
- Document that mock agents are local/dev only.

Acceptance criteria:

- Production cannot accidentally return mock quizzes due to a public env var.
- Local development mock mode still works intentionally.

## Phase 20: Flashcard Completion UI Fix

Files:

- `components/quiz/FlashcardViewer.tsx`

Plan:

- Store the final rating summary in explicit component state at the moment the final card is rated.
- Render the done screen from that final summary, not from potentially stale `ratedMap`.
- Keep `onComplete` using the same summary object.

Acceptance criteria:

- Final screen counts include the last card rating.
- `onComplete` and displayed summary match.

## Phase 21: Wiki Write Race Prevention

Files:

- `lib/wiki.ts`
- Possible Supabase migration.

Plan:

- For logs, prefer append-only database rows over whole-file read-modify-write.
- For wiki files, add optimistic concurrency:
  - Read current version metadata.
  - Write only if version still matches.
  - Retry on conflict a small number of times.
- Alternatively move wiki storage to a table with row-level versioning, then export/render markdown as needed.
- Keep storage snapshots if the current storage-file model is important for portability.

Acceptance criteria:

- Concurrent inbox log and profiler/tutor wiki writes do not lose entries.
- Wiki version history remains recoverable.

## Phase 22: Course Delete and Storage/Embedding Cleanup

Files:

- `app/api/courses/[courseId]/route.ts`
- `app/api/courses/[courseId]/archive/route.ts`

Plan:

- Keep initial course ownership check.
- Add `user_id` filters to subsequent materials, topics, flashcards, and course updates wherever the table has `user_id`.
- Explicitly delete embeddings for the user's course materials before or as part of material deletion if relying on cascades is not enough for partially migrated deployments.
- Check storage deletion errors and report or log them with course/user context.

Acceptance criteria:

- Course deletion remains safe even if a future refactor accidentally moves logic around.
- Embeddings/materials/storage do not drift after deletion.

## Phase 23: Documentation Updates

Files:

- `README.md`
- `.env.example`
- `supabase/README.md`
- Any setup/deployment docs.

Plan:

- Update key storage docs after Vault changes.
- Add `CRON_SECRET` instructions for self-hosting.
- Add timezone behavior or user timezone setup notes.
- Add any new Supabase migration order entries.
- Document dependency/security update requirements if versions move.

Acceptance criteria:

- A fresh deployer can run migrations in correct order.
- Docs match actual key/token storage behavior.

## Phase 24: Test and Verification Matrix

### Automated Checks

Run after each implementation batch:

- TypeScript no-emit check.
- Lint.
- Production build.
- Dependency audit.

### Security Regression Tests

Create tests or scripted checks for:

- Course file list/sign/upload cross-user denial.
- Tutor session read/write cross-user denial.
- Tutor course cross-user denial.
- Quiz/simulated exam cross-user denial.
- Inbox assignment cross-user denial.
- Professor reuse cross-user denial.
- Cron missing-secret denial.

### Functional Regression Tests

Create tests or manual QA scripts for:

- Onboarding with syllabus upload.
- Inbox upload, classification, retry, manual assignment, unreadable recovery.
- Profiler topic/exam extraction from a sample syllabus.
- Flashcard generation and FSRS review.
- Mastery update from flashcard review, practice quiz, simulated exam, and tutor verification.
- Scheduler plan generation from mastery, professor weight, due cards, homework, and exam proximity.
- Upcoming preview with timestamped homework.
- Calendar connect, schedule write, token refresh, disconnect.
- RAG with OpenAI embeddings and without OpenAI key fallback.
- Wiki read/write/edit/delete and concurrent log safety.

### Manual UI QA

Check:

- Auth and onboarding.
- Today page.
- Courses list and course detail.
- Materials view.
- Inbox.
- Tutor all modes.
- Essay mode.
- Review.
- Practice quiz and simulated exam.
- Progress.
- Settings, key fields, calendar, account deletion.

## Final Definition of Done

The repair work is complete when:

- No known cross-user access route remains from the findings.
- BYOK storage matches the README.
- Calendar tokens are not plaintext normal-table secrets.
- Scheduler and streaks use user-local dates.
- Mastery updates are consistent across flashcards, quizzes, tutor grading, and history.
- Inbox, profiler, RAG, scheduler, and calendar flows work in happy-path QA.
- `npm run lint`, `npx tsc --noEmit`, `npm run build`, and `npm audit --audit-level=moderate` pass or have documented, accepted exceptions.
- `DEEP_SCAN_FINDINGS.md` can be updated with each finding marked fixed, intentionally deferred, or no longer applicable.

