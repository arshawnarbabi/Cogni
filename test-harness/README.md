# Test suite

Three layers. Layer 1 needs nothing; Layers 2–3 run against a **local** Supabase
(your real project is never touched).

## Layer 1 — pure-logic unit tests (no deps)
```bash
npm test            # vitest: lib/time timezone math, lib/fsrs review clamp
```

## Local stack (needed for Layers 2–3)
```bash
supabase start                                   # local Postgres + Auth + Storage
node test-harness/apply-sql.mjs                  # applies supabase/setup.sql (+ Vault)
# copy the printed keys into .env.local (see below), then:
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_SERVICE_ROLE_KEY=<secret key from `supabase status`>
node test-harness/seed.mjs                       # seeds a test student + course data
```

`.env.local` (gitignored) for the dev server:
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<secret key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
MOCK_AGENTS=true        # mock AI for Layer 3; set false for the live-AI specs
```

## Layer 2 — engine tests against the local DB
```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<secret> SUPABASE_ANON_KEY=<publishable> \
  npm run test:integration   # review RPC, Vault, RAG keyword index
```

## Layer 3 — real app via Playwright
```bash
npm run dev                  # in another terminal (uses .env.local)
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<secret> APP_URL=http://localhost:3001 \
  npm run test:e2e -- app    # auth, today, scheduler, settings, course-delete
```

### Live-AI specs (cost real money — need keys in the test user's Vault)
```bash
ANTHROPIC_KEY=... OPENAI_KEY=... SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. node test-harness/store-key.mjs
# tutor, inbox classify, profiler, flashcards, embeddings, audio:
... npm run test:e2e -- live-ai
# quiz + simulated exam need MOCK_AGENTS=false on the dev server:
... npm run test:e2e -- quiz-exam-real
```

Generated artifacts (`seed-output.json`, `.auth/`, screenshots, `pw-results/`) are gitignored.
