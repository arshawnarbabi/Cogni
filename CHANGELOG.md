# Changelog

All notable changes to Cogni are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-06-09 · "Memory · MCP · Grades"

A major release built on top of the v1.3 production-hardening. Everything is
additive and BYOK.

> **Upgrading:** run [`supabase/big-update.sql`](supabase/big-update.sql) **once**
> before deploying (idempotent, self-contained). Fresh installs use `setup.sql`,
> which produces a byte-identical schema.

### Added
- **Persistent tutor memory.** Sessions distill (one Haiku call) into a session
  summary, a rolling per-course digest, and typed facts (misconceptions /
  preferences / goals). The next session opens with a "welcome back" recap, and
  misconceptions feed back into the study plan. Viewable, deletable, and
  pausable in Settings.
- **Built-in MCP server** ("bring your own Claude"). Connect Cogni to Claude
  Code / Desktop and study through your own subscription: 14 tools
  (read + write) and 4 prompts (`tutor`, `exam_prep`, `review_session`,
  `homework_help`). Reviews, grades, and sessions write back to mastery,
  schedule, and streak. SHA-256 token storage, 180-day expiry, fail-closed
  guards, per-day quotas, audit log.
- **Grade tracker + "what do I need on the final?"** Per-course gradebook
  (scheme auto-extracted from the syllabus or synced from Canvas), current
  weighted grade, per-category breakdown, and a points-proportional what-if
  calculator with secured / out-of-reach states.
- **Canvas import (S5).** Paste your school's Canvas URL + a personal access
  token to pull assignments, due dates, the grading scheme, and released
  grades; auto-syncs every morning.
- **Semester standing (S15).** One verdict per course (on-track / at-risk /
  critical) from grade risk × exam readiness × overdue work × consistency, at
  the top of Progress. Simulated-exam attempts now link to the real exam (S6).
- **Mastery decay.** Read-time exponential decay after a 7-day grace
  (60-day half-life) across scheduler, weak areas, readiness, and MCP.
- **Mastery carryover (S9).** A new course's topics seed from your decayed
  prior mastery in other courses instead of from zero.
- **Calendar feed (ICS).** Subscribe to exams, due dates, and study blocks from
  any calendar app — no OAuth.
- **Usage & cost dashboard.** Per-surface spend on your keys plus a
  "prompt caching saved you $X" estimate.
- **Exam readiness model, prerequisite graph, and grade-weighted scheduler
  urgency** feeding the daily plan and insight.

### Changed
- **Unified mastery evidence model** (EWMA) shared across tutor grading,
  quizzes, exams, and flashcard reviews — the displayed score is no longer
  path-order-dependent.
- **Durable job substrate** (jobs table + `claim_jobs` with an expired-lock
  reaper). Profiling/embedding/flashcards/distillation run as background jobs;
  uploads and onboarding no longer block on AI work.
- **Prompt caching** (up to 4 breakpoints) and a trivial-turn RAG skip cut
  tutor cost; history compaction keeps the first token fast.
- **Whole-syllabus profiling** (no more 12k-char truncation), incremental
  crash-safe embeddings, and a RAG similarity floor.
- Default deep-thinking model is now **Claude Opus 4.8**.

### Fixed
- **Quiz mastery silently never moved** when a quiz's questions resolved to one
  tracked topic (duplicate-topic upsert rejected by Postgres). Now folds
  same-topic evidence through the EWMA.
- **Grade what-if vanished pre-finals** when a pending final sat inside an
  already-graded category. Now uses points-proportional remaining weight.
- Idempotent flashcard reviews (exactly-once), retry/backoff with key-health
  circuit breaker, MCP fail-closed writes, and ~39 additional bugs found across
  three adversarial review cycles + a real-key live end-to-end test.

### Security
- **npm vulnerabilities 9 → 0** (dev/build/test tooling; no production
  dependency changed).
- API key never reaches logs (validation probe logs status only).
- Constant-time `CRON_SECRET` comparison.
- MCP `get_course_overview` ownership precheck.
- RLS on all new tables verified deny-by-default for client writes (empirically
  tested); service-role-only writes.

## [1.3.1] — 2026-06-04
Deployment & launch-readiness fixes.

## [1.3.0] — 2026-06-03
Production hardening — multi-tenant ready (signup gating, per-user AI quotas,
kill-switches, legal pages).

## [1.2.0] — 2026-06-03
Hardening & tests.

## [1.1.0] — 2026-05-02
Tutor visuals.

## [1.0.0] — 2026-04-22
Initial release.

[2.0.0]: https://github.com/arshawnarbabi/Cogni/releases/tag/v2.0.0
[1.3.1]: https://github.com/arshawnarbabi/Cogni/releases/tag/v1.3.1
[1.3.0]: https://github.com/arshawnarbabi/Cogni/releases/tag/v1.3.0
[1.2.0]: https://github.com/arshawnarbabi/Cogni/releases/tag/v1.2.0
[1.1.0]: https://github.com/arshawnarbabi/Cogni/releases/tag/v1.1.0
[1.0.0]: https://github.com/arshawnarbabi/Cogni/releases/tag/v1.0.0
