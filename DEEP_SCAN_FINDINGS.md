# Cogni Deep Scan Findings

Generated: 2026-05-13  
Scope: GitHub README for `s24b/Cogni`, local source files, Supabase SQL, API routes, agent flows, build/lint/typecheck, and dependency audit.  
Note: This is a findings report only. No application code was changed.

## README Understanding

Cogni is a self-hosted Next.js 16 + Supabase study system. Users upload syllabi, notes, exams, and other materials; AI agents classify and process them; professor/topic profiles are extracted; FSRS flashcards, quizzes, tutor sessions, daily study plans, nudges, RAG, wiki memory, Google Calendar blocks, and audio overviews are generated from the user's own course data. The highest-risk surfaces are authentication, service-role database access, storage file access, BYOK key storage, AI prompt/data boundaries, cron endpoints, and Supabase RLS/schema consistency.

## Verification Results

- `npx tsc --noEmit`: passed.
- `npm run build`: passed when network access was allowed for `next/font` Google font fetches. It fails in a no-network environment because Inter and Plus Jakarta Sans are fetched during build.
- `npm run lint`: failed with 18 errors and 4 warnings.
- `npm audit --audit-level=moderate`: found 8 vulnerabilities: 2 high, 6 moderate.

## Critical / High Severity Findings

### 1. Course file API can expose private signed file URLs across users

Evidence:
- `app/api/courses/files/route.ts:17-21` lists files for any supplied `courseId` and returns signed URLs.
- `lib/course-files.ts:15-22` filters only by `course_id`, not `user_id`.
- `lib/course-files.ts:73-79` creates a signed URL using the service-role client.

Impact:
An authenticated user who can obtain or guess another user's `courseId` can call `/api/courses/files?courseId=...` and receive signed URLs for that course's files. Supabase storage RLS is bypassed because the route uses the service-role client. The route appears unused in the main UI right now, but it is still exposed.

### 2. Course file upload can attach records to another user's course

Evidence:
- `app/api/courses/files/route.ts:30-52` accepts `courseId` from form data.
- `lib/course-files.ts:25-54` inserts `{ user_id: currentUser, course_id: suppliedCourseId }` with the service-role client.

Impact:
An authenticated user can create `course_files` rows linked to a course they do not own if they know the UUID. This creates cross-tenant data integrity problems and can make later course-file listing/signing behavior worse.

### 3. Tutor session read endpoint does not verify session ownership

Evidence:
- `app/api/agents/tutor/route.ts:46-56` accepts `sessionId`, authenticates the caller, then returns `getSessionMessages(sessionId)`.
- `lib/agents/tutor.ts:227-234` fetches session messages by `session_id` only.

Impact:
Any authenticated user with another user's `sessionId` can read that session's tutor messages and inline artifacts. Those messages may contain course content, personal learning data, essay content, AI-generated cards/quizzes, and user-uploaded attachment summaries.

### 4. Tutor POST can write into or continue another user's session

Evidence:
- `app/api/agents/tutor/route.ts:121-128` uses client-supplied `existingSessionId` and immediately calls `saveMessage`.
- `lib/agents/tutor.ts:237-253` inserts a message for a supplied `session_id` without confirming that the session belongs to the same user.

Impact:
An authenticated user can append messages to another user's tutor session if they know the UUID. The route also loads history for that session through `getSessionMessages(sessionId)`, so this combines with the read issue above.

### 5. Tutor and quiz routes trust arbitrary `courseId` values in several places

Evidence:
- `app/api/agents/tutor/route.ts:130-134` fetches `courses` by `course_id` without `user_id`.
- `lib/agents/tutor.ts:177-189` creates sessions for supplied `courseId` without validating course ownership.
- `app/api/agents/practice-quiz/route.ts:55-65` passes arbitrary `courseId` to `generatePracticeQuiz`.
- `lib/agents/practice-quiz.ts:57-62`, `137-168`, and `300-304` query topics/exams by `courseId` without `user_id`.
- `app/api/agents/simulated-exam/route.ts:66-71` checks content coverage by `courseId` without `user_id`.
- `app/api/agents/practice-quiz/grade/route.ts:29-39` records grades for supplied `courseId`.

Impact:
Several agent endpoints can read or act on another user's course/topic metadata if a course UUID is supplied. The most sensitive direct leak is topic/exam metadata into generated quizzes or simulated exams. There are also integrity issues where the current user's mastery rows or practice-test rows can reference another user's course/topic IDs.

### 6. Inbox manual assignment does not verify target course ownership

Evidence:
- `app/api/inbox/items/[itemId]/route.ts:36-69` verifies ownership of the inbox item, but never verifies that the submitted `courseId` belongs to the user.
- `lib/agents/inbox.ts:179-188` accepts `forceCourseId` and assigns material directly to that course without ownership validation.
- `app/api/inbox/upload/route.ts:14-15` accepts `courseIdHint` from form data and passes it into classification.

Impact:
A user can assign their material or inbox item to another user's course UUID. This creates cross-user course/material relationships and can feed later agents inconsistent data.

### 7. Cron endpoints can be callable with `Bearer undefined` if `CRON_SECRET` is missing

Evidence:
- `app/api/agents/scheduler/route.ts:17-20`
- `app/api/agents/nudge/route.ts:8-10`

Impact:
Both cron GET handlers compare the header to ``Bearer ${process.env.CRON_SECRET}``. If `CRON_SECRET` is absent in a deployment, the accepted header becomes `Bearer undefined`. The scheduler cron iterates all users and runs service-role work for each user.

### 8. OpenAI API keys are stored as plaintext rows, contrary to the README claim

Evidence:
- README says Anthropic and OpenAI keys are stored in Supabase Vault and never written to env vars or logs.
- `app/(shell)/settings/page.tsx:98-104` uses `ApiKeyField` for OpenAI.
- `app/api/user/keys/route.ts:27-31` stores arbitrary key values.
- `lib/user-keys.ts:15-20` writes `key_value` directly to `public.user_keys`.
- `supabase/user-keys.sql:2-7` defines `key_value text not null`.

Impact:
OpenAI keys are not stored in Vault. They are stored in a normal database table protected by RLS and server code, but not via Supabase Vault encryption. This is a security/design mismatch with the project documentation.

### 9. Google Calendar OAuth tokens are stored as plaintext database fields

Evidence:
- `app/api/calendar/callback/route.ts:43-51` stores `access_token` and `refresh_token`.
- `supabase/calendar-connections.sql:3-13` defines both token columns as `text`.

Impact:
Calendar refresh tokens are long-lived credentials. They are stored in a normal table rather than Vault or a dedicated encrypted secret store.

### 10. Dependency audit reports high and moderate vulnerabilities

Evidence:
- `npm audit --audit-level=moderate` reports:
  - High: `fast-uri <=3.1.1`
  - High: `next 9.3.4-canary.0 - 16.3.0-canary.5`
  - Moderate: `@anthropic-ai/sdk 0.79.0 - 0.91.0`
  - Moderate: `hono <=4.12.17`
  - Moderate: `ip-address <=10.1.0` via `express-rate-limit`
  - Moderate: `mermaid 11.0.0-alpha.1 - 11.14.0`
  - Moderate: `postcss <8.5.10` via Next

Impact:
The audit includes Next.js middleware/proxy bypass, DoS, cache poisoning, and SSRF advisories; Mermaid XSS/CSS injection/DoS advisories; and a path traversal/host confusion advisory in `fast-uri`.

### 11. Mermaid renders user/model-controlled diagrams into `innerHTML`

Evidence:
- `app/(shell)/tutor/_client.tsx:315-335` calls `mermaid.render(id, code)` and assigns `containerRef.current.innerHTML = svg`.
- `app/(shell)/tutor/_client.tsx:450-459` routes assistant markdown code blocks with `language-mermaid` into that renderer.
- `npm audit` reports multiple Mermaid sanitization vulnerabilities for the installed version.

Impact:
The tutor encourages Mermaid diagrams, and the diagram source is AI/user-controlled markdown. With the audited Mermaid issues, this creates an XSS/CSS injection/DoS-sensitive rendering path.

## Medium Severity Findings

### 12. Production auth proxy relies on `getSession()` for routing decisions

Evidence:
- `proxy.ts:28-36` uses `supabase.auth.getSession()` and redirects based on cookie session presence.

Impact:
API routes use `getUser()`, so core data access is better protected. The proxy itself can still make routing decisions from cookie session state rather than a verified user fetch. This can create stale/incorrect routing behavior around expired or tampered sessions.

### 13. App-wide date logic is UTC/server-time based while the product promises user-local scheduling

Evidence:
- `lib/agents/scheduler.ts:80`, `app/(shell)/today/page.tsx:24`, `app/api/user/streak/route.ts:10-11`, `lib/calendar.ts:226-244`, `lib/agents/nudge.ts:21-22`
- `lib/calendar.ts:242-244` labels the 8am-10pm window as local server time.

Impact:
On Vercel, these dates/times are typically UTC. Daily plans, streaks, due cards, nudge timing, "today", and Google Calendar study blocks can be off for users outside UTC. The README promises study blocks during 8am-10pm, but the implementation schedules based on server-time date math.

### 14. Upcoming preview homework grouping likely misses assignments

Evidence:
- `lib/agents/scheduler.ts:453-458` keys assignments by `a.due_date`.
- `lib/agents/scheduler.ts:487` looks up assignments by a `YYYY-MM-DD` date string.
- `supabase/schema.sql:113-115` stores assignment `due_date` as `timestamptz`.

Impact:
If Supabase returns timestamps such as `2026-05-13T18:00:00+00:00`, they will not match preview keys like `2026-05-13`. Homework can be absent from the 6-day preview even when it is inside the queried window.

### 15. Course creation trusts `existingProfessorId` without ownership validation

Evidence:
- `app/api/courses/create/route.ts:57-73`
- `app/api/onboarding/complete/route.ts:56-75`

Impact:
A user can create a course referencing another user's professor UUID. This creates cross-tenant foreign-key relationships and can confuse professor profile/wiki behavior.

### 16. Onboarding completion is non-transactional and not idempotent

Evidence:
- `app/api/onboarding/complete/route.ts:43-51` inserts the user row first.
- `app/api/onboarding/complete/route.ts:56-138` then creates professors, courses, materials, wiki files, and profiler jobs.

Impact:
If any later step fails, the user can be left partially onboarded. A retry can fail at the duplicate `users` insert before repairing the remaining setup.

### 17. Upload flows can leave orphaned storage or database records on mid-flow failure

Evidence:
- `app/api/inbox/upload/route.ts:82-118` uploads to storage, inserts `materials`, then inserts `inbox_items`; failures after upload do not clean earlier artifacts.
- `app/api/onboarding/upload-syllabus/route.ts:25-31` uploads syllabus files before onboarding completion creates DB records.
- `app/api/courses/create/route.ts:97-120` can create the course and upload syllabus storage before material metadata fails.

Impact:
Storage files and partial rows can accumulate without visible UI references. This can also affect storage costs and future duplicate/processing behavior.

### 18. Account reset/deletion cleanup can leave storage objects behind

Evidence:
- `app/api/settings/account/route.ts:26-32` deletes the user row before attempting storage cleanup.
- `app/api/settings/account/route.ts:4-16` lists only `limit: 200` per prefix and only the hard-coded prefixes `userId` and `userId/syllabuses`.
- Similar reset logic exists in `app/api/settings/reset/route.ts`.

Impact:
Accounts with more than 200 files per bucket/prefix, nested paths beyond the hard-coded prefixes, or a cleanup failure after DB deletion can leave orphaned private storage objects.

### 19. Tutor attachment ingestion lacks server-side size/count limits

Evidence:
- `app/api/agents/tutor/route.ts:60-86` accepts `attachments` from JSON.
- `app/api/agents/tutor/route.ts:24-44` converts attachments directly into Anthropic content blocks.

Impact:
The route can receive large base64 payloads or many attachments. This can create memory pressure, request-size failures, and unexpected AI cost exposure independent of any client-side limits.

### 20. File validation is mostly extension-based

Evidence:
- `app/api/inbox/upload/route.ts:33-44`
- `app/api/onboarding/upload-syllabus/route.ts:16-18`
- `app/api/courses/files/route.ts:42-45`

Impact:
Allowed uploads are accepted based mainly on filename extension and then stored or parsed. Incorrect MIME/content can trigger parser failures, storage of unexpected content, or unnecessary AI/embedding work.

### 21. RAG keyword fallback has no obvious full-text index

Evidence:
- `lib/rag.ts:162-168` uses `.textSearch('content', ...)`.
- `supabase/schema.sql:331` adds only a vector IVFFlat index for embeddings.

Impact:
Keyword fallback can become slow as `material_embeddings.content` grows because there is no matching full-text index visible in the migrations.

### 22. `material_embeddings` replacement deletes by material only

Evidence:
- `lib/rag.ts:61-63` deletes all rows for `materialId` without also checking `user_id`.

Impact:
Callers usually pass materials they just created or own, but the function itself is not tenant-defensive. If called with a cross-tenant material ID through another route bug, it can delete another user's embeddings.

### 23. Simulated exam code references an `exams.question_count` column that is not in the schema

Evidence:
- `lib/agents/practice-quiz.ts:137-148` selects `question_count`.
- `supabase/schema.sql:96-105` defines `exams` without `question_count`.
- No migration in `supabase/` adds `question_count` to `exams`.

Impact:
The Supabase select will error or omit expected data depending on client behavior, so simulated exams fall back to the default question count instead of using stored exam metadata.

### 24. Build depends on live Google Fonts fetches

Evidence:
- Initial `npm run build` failed without network while fetching Inter and Plus Jakarta Sans through `next/font`.
- The same build passed when network access was allowed.

Impact:
Production builds in restricted-network CI/CD environments can fail even when the code compiles.

## Low Severity / Cleanup Findings

### 25. Lint currently fails

Evidence:
- `npm run lint` reports 18 errors and 4 warnings.
- Main categories:
  - React compiler/static component errors in course and progress UI icon rendering.
  - `setState` synchronously inside effects in inbox, settings appearance, tutor, onboarding, and essay portal components.
  - `no-explicit-any` errors in page shaping code.
  - unescaped apostrophes in settings knowledge store text.
  - missing image `alt` warnings.
  - missing dependency warning in `components/quiz/QuizSession.tsx:779`.

Impact:
The project builds, but lint is not green. These issues reduce CI confidence and hide future regressions.

### 26. `skipLibCheck` and `allowJs` reduce type-check strictness

Evidence:
- `tsconfig.json:5-7`

Impact:
The app has `strict: true`, but library checking is skipped and JS is allowed. Type errors in dependencies or any JS files are less visible.

### 27. Service-role client is intentionally untyped and widely used

Evidence:
- `lib/supabase/server.ts:29-41`

Impact:
Because service-role calls bypass RLS and are untyped, route-level ownership checks must be perfect. The current findings show that several route-level checks are missing or incomplete.

### 28. `getMyFiles()` authenticates but does not scope the file list by user

Evidence:
- `lib/course-files.ts:90-95` returns `listCourseFiles(courseId)`.
- `lib/course-files.ts:15-22` does not filter by user.

Impact:
If used by server components later, this helper will inherit the same cross-user listing issue as the course files API.

### 29. Course delete/archive queries rely on prior ownership checks but later queries are not tenant-scoped

Evidence:
- `app/api/courses/[courseId]/route.ts:17-24` verifies course ownership, then `materials` query at `27-31` lacks `user_id`.
- `app/api/courses/[courseId]/archive/route.ts:20-27` verifies course ownership, then topic/card updates at `29-58` and `87-107` often rely only on `course_id` or `topic_id`.

Impact:
The prior ownership check makes normal use safe. The later service-role queries are still less defensive than the rest of the codebase, and any future change that reuses those blocks without the initial check would be risky.

### 30. Some service-role updates ignore write errors

Evidence:
- Examples include `app/api/inbox/items/[itemId]/route.ts:58-69`, `app/api/inbox/items/[itemId]/retry/route.ts:26-28`, `app/api/settings/session-length/route.ts:15-23`, `app/api/settings/tutor-limit/route.ts:15-18`, and several agent background updates.

Impact:
The UI can report success even when a database update silently failed. This makes production debugging harder and can leave user-visible state out of sync.

### 31. `CRON_SECRET` documentation may be misleading for non-Vercel/self-hosted deployments

Evidence:
- README states `CRON_SECRET` is auto-generated by Vercel and does not need to be set manually.
- `.env.example` does not list `CRON_SECRET`.
- The app supports self-hosting and local development.

Impact:
Users deploying outside Vercel or with different cron infrastructure may not realize the cron secret is required for safe GET endpoints.

### 32. `NEXT_PUBLIC_MOCK_AGENTS` is a public env toggle for mock agent behavior

Evidence:
- `.env.example:13-14`
- `app/api/agents/practice-quiz/route.ts:50-53`
- `app/api/agents/simulated-exam/route.ts:59-61`

Impact:
If this public variable is accidentally enabled in production, quiz/exam endpoints return canned mock content.

### 33. Flashcard completion summary can omit the final rating in displayed counts

Evidence:
- `components/quiz/FlashcardViewer.tsx:91-131` computes final counts locally for `onComplete`.
- `components/quiz/FlashcardViewer.tsx:144-170` renders the done screen from `ratedMap`, which may not yet include the last `setRatedMap` update.

Impact:
The callback summary is correct, but the on-screen "Good/Easy" count and rating chips can lag by one card on the completion screen.

### 34. Wiki writes can race and overwrite each other

Evidence:
- `lib/wiki.ts:41-46` implements append by read-modify-write.
- Tutor `write_wiki_pattern`, profiler writes, and inbox logging can run concurrently.

Impact:
Concurrent agent activity can lose log entries or wiki updates because storage writes are whole-file overwrites.

### 35. Storage cleanup in course deletion does not remove embeddings directly

Evidence:
- `app/api/courses/[courseId]/route.ts:47-52` relies on course-row cascade.
- `supabase/schema.sql:214-218` makes `material_embeddings.material_id` cascade from materials.

Impact:
This is safe if all DB constraints are present. If migrations are partially applied, material storage and embedding rows can drift.

## Areas Scanned More Deeply

- README product/architecture claims.
- Auth callback and proxy behavior.
- Supabase service-role client and all service-role route patterns.
- Storage buckets and storage path conventions.
- Course/material/inbox/tutor/practice-quiz APIs.
- Vault/user key handling.
- Google Calendar OAuth and scheduling.
- FSRS review RPC.
- Scheduler, nudge, RAG, profiler, inbox, tutor, audio overview, web enrichment agents.
- Supabase schema and migrations.
- Markdown/Mermaid rendering path.
- Build, lint, typecheck, and dependency audit.

