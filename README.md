<img src="assets/cogni-banner-github.png" width="100%" alt="Cogni" />

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E" alt="Supabase" />
  <img src="https://img.shields.io/badge/Claude-Sonnet%204.6-CC785C" alt="Claude" />
  <img src="https://img.shields.io/badge/release-v1.3.1-1D4ED8" alt="v1.3.1" />
  <img src="https://img.shields.io/badge/hosting-self--host%20%7C%20multi--tenant-7C3AED" alt="Self-host or multi-tenant" />
  <img src="https://img.shields.io/badge/status-beta-F59E0B" alt="Beta" />
  <a href="https://trycogni.arshawnarbabi.com/"><img src="https://img.shields.io/badge/website-trycogni.arshawnarbabi.com-1D4ED8" alt="Website" /></a>
  <a href="https://vercel.com/new/clone?repository-url=https://github.com/arshawnarbabi/Cogni"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

<br />

Cogni decides what to study, when to study, and how — so you just show up. Feed it your syllabi, lecture notes, past exams, and course materials. It classifies and processes everything automatically, extracts your topics, maps your professor's grading weights, and generates a prioritized study plan every morning based on your current mastery and upcoming exams. The tutor pulls from your actual course materials. Flashcards are scheduled by FSRS at the card and topic level. Study blocks land in your Google Calendar. All you do is study. Always BYOK on Vercel + Supabase.

Run it two ways: **self-hosted** for a single user, or **hosted multi-tenant** — one operator running a public instance for many users (open / invite-code / `.edu` signup gating, per-user AI quotas, kill-switches, legal pages, and more). Either way it stays BYOK and self-hostable.

> **v1.3.0 — "Production Hardening · Multi-Tenant Ready":** Cogni is now production-hardened for public, multi-tenant hosting in addition to single-user self-hosting. Everything is additive and BYOK; see [Production / multi-tenant hosting](#-production--multi-tenant-hosting).

> **Beta:** Cogni is under active development. Expect rough edges, verify important study data, and test thoroughly before relying on it for critical coursework.

<br />

## 🔄 How it works

1. **Upload your course materials** — syllabi, lecture notes, past exams, anything you have. Claude classifies each file, extracts topics with professor weights, exam dates, and grade breakdowns. Your course is fully mapped in minutes.
2. **Every morning at 5am UTC, a plan is generated** — the scheduler scores every topic by mastery deficit, professor weight, and exam proximity. It allocates your session time, orders your flashcard review, and writes study blocks to Google Calendar.
3. **Open the app and study** — flashcard review, tutor sessions, and quizzes all update your mastery in real time. Tomorrow's plan adapts to what you did today.

You don't decide what to study. Cogni does.

<br />

## 📸 Screenshots

<table>
  <tr>
    <td><img src="assets/screenshots/cogni-auth.png" alt="Auth" /></td>
    <td><img src="assets/screenshots/today-tab.png" alt="Today" /></td>
  </tr>
  <tr>
    <td><b>Sign in</b> — Google OAuth or email/password</td>
    <td><b>Today</b> — AI-generated daily plan with streak, insight, and study tasks</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/courses-tab.png" alt="Courses" /></td>
    <td><img src="assets/screenshots/inside-course-page-2.png" alt="Topics" /></td>
  </tr>
  <tr>
    <td><b>Courses</b> — coverage and mastery bars per course</td>
    <td><b>Topics</b> — per-topic mastery, coverage, and due card count</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/flashcard.png" alt="Flashcard review" /></td>
    <td><img src="assets/screenshots/flashcard-artifact.png" alt="Tutor generating flashcards" /></td>
  </tr>
  <tr>
    <td><b>Flashcard review</b> — FSRS 4-point rating (Again / Hard / Good / Easy)</td>
    <td><b>Tutor → flashcards</b> — inline card generation during a session</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/quiz-artifact.png" alt="Tutor quiz" /></td>
    <td><img src="assets/screenshots/essay-mode.png" alt="Essay mode" /></td>
  </tr>
  <tr>
    <td><b>Tutor → quiz</b> — MC with LaTeX rendering and auto-grading</td>
    <td><b>Essay mode</b> — split-view editor with tracked changes and three assist levels</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/inbox-tab.png" alt="Inbox" /></td>
    <td><img src="assets/screenshots/progress-tab.png" alt="Progress" /></td>
  </tr>
  <tr>
    <td><b>Inbox</b> — upload files, Haiku classifies and routes them automatically</td>
    <td><b>Progress</b> — 30-day mastery trends and weak areas across all courses</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/inside-course-page-3.png" alt="Exams and materials" /></td>
    <td><img src="assets/screenshots/google-calendar.png" alt="Google Calendar" /></td>
  </tr>
  <tr>
    <td><b>Exams + materials</b> — scores, processed materials, test history</td>
    <td><b>Calendar</b> — study blocks written to a dedicated Cogni Study calendar</td>
  </tr>
  <tr>
    <td colspan="2"><img src="assets/screenshots/settings-tab.png" alt="Settings" /></td>
  </tr>
  <tr>
    <td colspan="2"><b>Settings</b> — BYOK key status, calendar connection, session length, daily message limit</td>
  </tr>
</table>

<br />

## 🧠 Features

- **FSRS spaced repetition** — full card-level state (stability, difficulty, reps, lapses). 4-point ratings: Again / Hard / Good / Easy. Atomic RPC updates FSRS state and topic mastery in one transaction.
- **AI study planner** — daily plan prioritized by mastery deficit × professor weight × exam proximity. Generates a 6-day ahead preview. Writes flashcard review blocks to Google Calendar. Plans, streaks, due cards, and calendar blocks all use your local timezone (auto-detected at onboarding).
- **Claude-powered tutor** — four modes: Answer (direct), Teach (Socratic), Focus (weak-area routing), Essay (split-view editor with tracked changes). Deep thinking mode switches to Claude Opus 4.7 with extended thinking for hard problems. Native web search. Inline flashcard, quiz, chart, and Mermaid-diagram generation. Session persistence with auto-naming.
- **Professor profiling** — builds a per-professor wiki from past exams, syllabi, and graded materials. Tracks question depth, phrasing style, and topic weights. Persists across semesters — add a new course with the same professor and their profile is already there.
- **Syllabus profiler** — upload a PDF, Claude extracts topics with professor weights, exam dates, and grade breakdowns. RAG-enriched before extraction.
- **RAG over course materials** — pgvector with OpenAI text-embedding-3-small (1536 dims). Keyword search fallback if no OpenAI key. Top-5 chunks injected into every tutor context.
- **Inbox pipeline** — upload files or notes → Haiku (+ vision) classifies tier, course, and due date → auto-triggers profiler (tier 1) and flashcard generation (tier 1–2).
- **Wiki memory** — tutor writes durable insights to per-user markdown files (`learning_profile.md`, `weak_areas.md`, `professor_*.md`). Loaded verbatim into every session — no retrieval step.
- **Practice quiz + simulated exam** — MC and short-answer, auto-graded. Simulated exam mirrors your professor's style and topic weighting using wiki context. Mastery updated on grade.
- **Audio overview** — Claude Sonnet scripts a two-host podcast from your course materials; OpenAI TTS converts it to audio. Requires both an Anthropic and OpenAI key.
- **Google Calendar integration** — study blocks scheduled during 8am–10pm, written to a dedicated "Cogni Study" calendar.
- **BYOK** — Anthropic and OpenAI keys stored in Supabase Vault (encrypted). No AI keys in env vars.

<br />

## ⚙️ Architecture

**Two-level spaced repetition.** Each flashcard carries full FSRS state (`stability`, `difficulty`, `reps`, `lapses`, `state`, `last_review`, `next_review_date`). Topic mastery is a separate blended score updated on every review, quiz, and exam. The scheduler uses topic mastery to allocate session time; FSRS drives card-level scheduling independently.

**Atomic review RPC.** `review_card_atomic()` runs a single Postgres transaction that updates all FSRS fields on the flashcard and applies a mastery delta to `topic_mastery`. Mastery deltas: Again = −0.1, Hard = +0.02, Good = +0.08, Easy = +0.12, clamped 0–1.

**Scheduler priority formula.**
```
priority = (professor_weight − mastery_score) × professor_weight × examProximityMultiplier
```
Exam proximity multipliers: >30 days = 1×, >14 = 1.5×, >7 = 2×, >3 = 3×, ≤3 = 5×. Session minutes are allocated proportionally across courses.

**Karpathy wiki pattern.** The tutor has a `write_wiki_pattern` tool that writes markdown to per-user files in Supabase Storage. The profiler writes `professor_*.md` on every syllabus upload. All wiki files are loaded verbatim into tutor session context on every request — no vector retrieval, just direct inject.

**Streaming tutor with native web search.** Anthropic Messages API with streaming. Tools: `create_flashcards`, `create_quiz`, `create_chart`, `open_essay_mode`, `grade_answer`, `suggest_edit`, `write_wiki_pattern`. Real-time web lookup via Anthropic's native `web_search_20250305` tool. Markdown answers render LaTeX (KaTeX) and Mermaid diagrams.

**RAG pipeline.** OpenAI `text-embedding-3-small` (1536 dims) stored in pgvector with an IVFFlat index. Chunks: 3200 chars, 400-char overlap, split on paragraph/sentence boundaries. Retrieval: top-5 chunks per query, course-scoped. Falls back to LIKE keyword search if no OpenAI key is present.

**Inbox classification pipeline.** Upload → Haiku (+ vision for PDFs/images) classifies tier (1 = syllabus, 2 = primary, 3 = supplementary, 4 = misc), course, homework status, and due date → triggers profiler for tier-1 materials → triggers flashcard generation for tier-1 and tier-2 materials with fewer than 5 existing cards per topic.

<br />

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16, React 19, TypeScript 5 |
| Database | Supabase (PostgreSQL + pgvector + Auth + Storage) |
| AI — reasoning | Claude Sonnet 4.6 (tutor, profiler, exams, web enrichment) |
| AI — deep thinking | Claude Opus 4.7 with extended thinking (tutor deep think mode) |
| AI — lightweight | Claude Haiku 4.5 (flashcards, quizzes, inbox classification, session naming) |
| AI — embeddings | OpenAI text-embedding-3-small (optional; enables RAG) |
| Spaced repetition | ts-fsrs 5.3.2 |
| Styling | Tailwind CSS 4, shadcn/ui |
| Animation | Framer Motion |
| Charts | Recharts |
| Rich text | TipTap |
| Math rendering | KaTeX |
| Diagrams | Mermaid |
| Icons | Phosphor Icons |
| File export | @react-pdf/renderer, docx |

<br />

## 🚀 Setup / Deployment

> Setup takes ~30–45 minutes. You'll need a Supabase account and a Vercel account. The steps below cover a quick **single-user self-host**; for **production multi-tenant** hosting, follow [`DEPLOYMENT.md`](DEPLOYMENT.md) (see [Production / multi-tenant hosting](#-production--multi-tenant-hosting)).

**Step 1 — Fork and deploy**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/arshawnarbabi/Cogni)

Fork the repo and deploy to Vercel, or run locally with `npm run dev`. **Vercel Hobby (free) is sufficient** — Fluid Compute gives crons a 300s duration and 100 crons per project, so you don't need Pro to run the daily scheduler.

**Step 2 — Supabase project**

Create a new Supabase project, then **enable the Vault extension** (Dashboard → Database → Extensions → `supabase_vault`) — it stores your API keys and calendar tokens. Then set up the database:

- **Quick:** paste [`supabase/setup.sql`](supabase/setup.sql) into the SQL editor and run it once. It bundles every migration in the correct order and is idempotent, so it's safe to re-run later to pick up schema changes.
- **Manual:** run the individual files in the order in [`supabase/README.md`](supabase/README.md).

**Step 3 — Environment variables**

Add these to your Vercel project settings (or `.env.local` for local dev):

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `CRON_SECRET` | ✅ | Long random secret used by Vercel cron endpoints |
| `NEXT_PUBLIC_APP_URL` | ✅ | Your deployment URL (e.g. `https://your-app.vercel.app`) |
| `GOOGLE_CALENDAR_CLIENT_ID` | Optional | Google Cloud Console — Calendar OAuth |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Optional | Google Cloud Console — Calendar OAuth |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional | Cloudflare Turnstile CAPTCHA — public site key |
| `TURNSTILE_SECRET_KEY` | Optional | Cloudflare Turnstile CAPTCHA — secret key |
| `SENTRY_DSN` | Optional | Sentry error monitoring — server DSN |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | Sentry error monitoring — client DSN |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Optional | Sentry source-map upload at build time |
| `CRON_HEARTBEAT_SCHEDULER_URL` | Optional | Heartbeat alert URL for the scheduler cron |
| `CRON_HEARTBEAT_NUDGE_URL` | Optional | Heartbeat alert URL for the nudge cron |
| `CRON_HEARTBEAT_MAINTENANCE_URL` | Optional | Heartbeat alert URL for the maintenance cron |
| `OPERATOR_SECRET` | Optional | Bearer secret guarding the operator console + audit endpoints |

The optional vars above the calendar row power v1.3.0's [production / multi-tenant hardening](#-production--multi-tenant-hosting). Every one is a **no-op if unset**, so a single-user self-host can ignore them.

Anthropic and OpenAI keys are **not** env vars. Users add them in Settings after deploying.

> Set `CRON_SECRET` yourself in Vercel and keep it long and random. It secures the daily scheduler (5am UTC) and nudge check (6am UTC) endpoints so only callers with the bearer token can invoke them.

> **Email confirmation / password reset** uses transactional email via **Resend**, configured in the **Supabase dashboard** (Authentication → SMTP), not via env vars.

**Step 4 — Google OAuth (sign-in)**

First, create OAuth 2.0 credentials in [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth 2.0 Client ID (Web application). Add this as an authorized redirect URI:
```
https://<your-supabase-ref>.supabase.co/auth/v1/callback
```

Then in Supabase dashboard → Authentication → Providers → Google:
- Add your client ID and secret
- Set Site URL to `https://your-app.vercel.app`
- Add `https://your-app.vercel.app/auth/callback` to the Redirect URLs list

**Step 5 — Add your Anthropic key**

After deploying, go to Settings and add your Anthropic API key. Required for all AI features. Keys are stored in Supabase Vault — never in env vars.

**Step 6 — Optional: OpenAI key**

Add an OpenAI key in Settings to enable pgvector RAG. Without it, keyword search fallback is active.

**Step 7 — Optional: Google Calendar**

In Google Cloud Console → APIs & Services:
- Enable the **Google Calendar API**
- In your OAuth 2.0 credentials, add this as an authorized redirect URI:
```
https://your-app.vercel.app/api/calendar/callback
```

Make sure `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` are set in your env vars (step 3). Then connect in Cogni Settings → Calendar.

<br />

## 🏢 Production / multi-tenant hosting

Cogni runs two ways:

- **Quick self-host (single user)** — the 7 steps above. Deploy, add your own key, study. Nothing below is required.
- **Production multi-tenant** — one operator hosting a public instance for many users. Everything is additive and stays BYOK (each user pays their own Anthropic/OpenAI usage with their own key). Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) — the full production runbook of manual steps.

**Free-tier deployable ($0).** A full production instance runs on free tiers: **Vercel Hobby** (Fluid Compute provides 300s cron duration and 100 crons per project — Pro is not needed) + **Supabase Free** + **Resend** free email. The operator pays nothing for AI itself, since it's BYOK.

**Hardening highlights (v1.3.0):**

- **Bypass-proof signup gating** — open / invite-code / `.edu` modes enforced at the **database layer** (trigger on `auth.users`), so it covers the server route, direct signups, and OAuth.
- **CAPTCHA** — Cloudflare Turnstile on signup.
- **Consent + age capture** — collected at signup (email + OAuth). Plus a full password-reset flow.
- **Legal pages** — Terms, Privacy (with AI sub-processor disclosure), and Acceptable-Use.
- **Per-user AI quotas + suspend** — daily AI quotas and account suspend enforced on every AI route.
- **Image moderation** — applied on uploads.
- **Operator kill-switches** — instantly pause signups or disable AI via runtime config, no redeploy.
- **Operator console + audit log** — operator console with an append-only audit log.
- **GDPR data export** — per-user data export.
- **Observability** — Sentry error monitoring, cron heartbeat alerting, and an `/api/health` endpoint. Plus Report-Only CSP and security headers, ~58 raw error leaks sanitized into stable codes, and Vault read-back verification on key storage.

All of the above is wired through the optional env vars in the [Setup / Deployment](#-setup--deployment) env table (step 3) — every one is a no-op if unset, so existing single-user deployments are unaffected. `supabase/setup.sql` already bundles the production-hardening migrations (its "section 10" block).

<br />

## 🔑 API Keys

**Anthropic (required)** — Powers the tutor, profiler, flashcard generation, quizzes, and inbox classification. Get a key at [console.anthropic.com](https://console.anthropic.com). Typical usage for a single student: ~$2–5/month.

**OpenAI (optional)** — Used only for `text-embedding-3-small` embeddings. Enables pgvector RAG for richer tutor context and better syllabus profiling. Without it, Cogni falls back to keyword search. Get a key at [platform.openai.com](https://platform.openai.com).

Both keys are stored in Supabase Vault (encrypted at rest). They are never written to env vars or logs.

<br />

## 💻 Local Development

```bash
git clone https://github.com/arshawnarbabi/Cogni
cd Cogni
npm install
cp .env.example .env.local
# fill in .env.local with your Supabase credentials
npm run dev
```

Vercel Cron Jobs do not run locally (scheduler fires at 5am UTC, nudge at 6am UTC in production — Vercel Hobby/Fluid Compute is enough to run them). The scheduler runs automatically when you navigate to Today if no plan exists for today. In local development (`NODE_ENV=development`), a Dev Tools section in Settings exposes a reset-account helper.

<br />

## 🧪 Testing

```bash
npm test                 # unit tests — timezone/FSRS logic (no setup needed)
npm run test:integration # engine tests vs a local Supabase (review RPC, Vault, RAG)
npm run test:e2e         # Playwright end-to-end vs the running app
```

Unit tests run anywhere. The integration and end-to-end suites run against a **local** Supabase stack (`supabase start`) so your real project is never touched — see [`test-harness/README.md`](test-harness/README.md) for the seed/apply scripts and setup.

<br />

## 📄 License

[MIT](LICENSE) — Copyright (c) 2026 Arshawn Arbabi

<br />

## ⚠️ Active Project

Cogni is an active personal project. Most features work as described, but some may have rough edges or occasional bugs — contributions and bug reports are welcome.
