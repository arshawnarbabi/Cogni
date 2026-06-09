# Cogni — Deployment Runbook (manual `[you]` steps)

All the **code-side** production-readiness work is done — merged to `main` and released as **v2.0.0** (building on the v1.3.0 production-hardening).
This is the ordered list of the **manual steps only you can do** (accounts, dashboards, decisions). Do them in order. See `.env.example` for every variable.

> ## 💸 Cost: $0 — this whole pilot runs on free tiers
> | Service | Plan | Note |
> |---|---|---|
> | **Vercel** | Hobby (free) | Fluid Compute gives 300s crons — no Pro needed (verified June 2026) |
> | **Supabase** | Free | 2-project limit; pauses after 7 days idle (the repo's keepalive workflow prevents that); **no PITR** (accepted for pilot) |
> | **Resend** (email) | Free | 3,000 emails/mo, 100/day — plenty for a pilot |
> | **Cloudflare Turnstile** (CAPTCHA) | Free | optional |
> | **Sentry** (errors) | Free | optional |
> | **Healthchecks.io** (cron/uptime alerts) | Free | optional |
>
> The **AI itself costs you nothing** — it's BYOK (each user pays their own Anthropic/OpenAI usage with their own key). The only non-free things are *optional later upgrades* (Vercel Pro, Supabase Pro for backups) you'd only want once you have real users.

---

## 1. Supabase project
1. Create the **production Supabase project** (region is immutable — pick closest to your users; you're at the 2-project free limit, so free a slot).
2. **Enable the `supabase_vault` extension** (Database → Extensions) **before** running SQL — BYOK breaks without it. *(On newer projects Vault is often already enabled by default — just verify it's on.)*
3. Run **`supabase/setup.sql`** once in the SQL editor (it bundles sections 1–10, idempotent). It auto-raises `maintenance_work_mem` for the pgvector index build so it completes on the free tier. *(⚠️ An outdated copy will abort at that index with `ERROR: 54000: memory required is N MB, maintenance_work_mem is 32 MB` and silently leave every later object uncreated — a partial schema that 500s onboarding/key-save later. If you see that error, you're on an old `setup.sql`: pull latest and re-run.)*
4. **Reusing an existing project?** `setup.sql` is idempotent and non-destructive — re-running the latest version **heals a partial/aborted prior run**. (Its only deletes are a lossless professor/course de-dupe and the legacy `user_keys`→Vault migration; no table drops.)
5. **Verify** — paste this in the SQL editor; **every `ok` must be `true`** (it catches the partial-schema failure mode):
   ```sql
   select 'idx idx_material_embeddings_embedding' as obj, to_regclass('public.idx_material_embeddings_embedding') is not null as ok
   union all select 'fn match_material_chunks',  exists(select 1 from pg_proc where proname='match_material_chunks')
   union all select 'fn store_user_secret',      exists(select 1 from pg_proc where proname='store_user_secret')
   union all select 'fn enforce_signup_policy',  exists(select 1 from pg_proc where proname='enforce_signup_policy')
   union all select 'table app_config',          to_regclass('public.app_config') is not null
   union all select 'col users.tos_accepted_at', exists(select 1 from information_schema.columns where table_name='users' and column_name='tos_accepted_at');
   ```
   Then also confirm RLS is `on` for every table; the 4 storage buckets exist; and the Vault / `review_card_atomic` RPCs are **not** granted to `anon`.

## 2. Email

> ### ✅ Recommended for the pilot: **no email** ($0, zero setup)
> Skip the Resend setup below entirely. Instead:
> 1. Supabase → Authentication → **Sign In / Providers → Email** → leave **"Confirm email" OFF**.
> 2. In Vercel, set **`NEXT_PUBLIC_PASSWORD_RESET_ENABLED=false`**.
>
> Users then sign up with email/password (no confirmation email) or **Google**. The only tradeoff is **no self-serve password reset** — the auth page warns users, and you can reset a locked-out user from the **operator console** (see the Operator runbook below). Wire up Resend (steps below) only when you open to public signup, to block fake-email abuse.

**Full email setup (Resend) — for when you open to public signup:** *(do before turning on confirmation)*
1. Create a **Resend** account → **Domains → Add Domain** and verify a sending domain. Verification needs **SPF + DKIM** DNS records only (✏️ *DMARC is NOT required for verification — it's optional/recommended; if you add it, start with `p=none`*).
2. Supabase Dashboard → Authentication → **Emails → SMTP Settings** (its own page): enable custom SMTP, then host `smtp.resend.com`, port `465`, user `resend`, pass = a Resend **API key**, sender = an address on your verified domain. *(These Resend SMTP values were re-verified correct, June 2026.)*
3. Send a **real test email** and confirm it lands in a Gmail/Outlook **inbox, not spam**.
4. Authentication → **Sign In / Providers** → Email → **turn ON "Confirm email"** (✏️ *the sidebar item formerly called "Providers" is now "Sign In / Providers"*).

## 3. Google OAuth (optional but recommended)
✏️ *Corrected — the redirect URI is the #1 thing people get wrong here.* Google sign-in needs an OAuth client in **Google Cloud**, with the client ID/secret pasted into **Supabase**:
1. **Google Cloud Console → Google Auth Platform → Clients** (OAuth moved here in 2026) → **Create client → Web application**. First time, complete the app registration under **Branding** (app name + support email) and set **Audience → External**.
2. In that client, add an **Authorized redirect URI** of exactly `https://<your-project-ref>.supabase.co/auth/v1/callback` — this is the **Supabase** auth callback, **NOT** your app's `/auth/callback`. *(This is a Google Cloud field; Supabase only stores the client ID/secret.)*
3. Copy the **Client ID + Secret** into **Supabase → Authentication → Sign In / Providers → Google** and enable it.
4. Your app's own domain + `/auth/callback` go in Supabase → Authentication → **URL Configuration** (Section 4, step 5) — not in Google Cloud.

*(Supabase social login only requests basic identity scopes, so Google doesn't force a verification/test-user list for these.)*

## 4. Vercel — FREE (Hobby) plan is enough
1. Import the repo and deploy from `main`.
2. **Stay on Hobby (free).** Ensure **Fluid Compute is enabled** (Settings → Functions — it's the default). With Fluid Compute, Hobby allows `maxDuration` up to **300s**, so the crons run fine — *no Pro upgrade needed.* (Cron limits on Hobby: up to 100 jobs/project, once-per-day max frequency, fired within the scheduled hour — all of which our 2 daily + 1 weekly crons satisfy.)
3. Set env vars (Production scope) per `.env.example`. **Required:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`. Confirm `MOCK_AGENTS` is **unset**.
4. Attach your **custom domain** (free on Hobby); set `NEXT_PUBLIC_APP_URL` to it (build-time-baked, so set before the prod build).
5. Supabase → Authentication → URL Configuration: set **Site URL** + redirect URLs to the prod domain.

> **Upgrade to Pro only later, if** a cron starts hitting the 300s wall (i.e. you have so many users that one daily run can't finish in 5 minutes) — that's a good problem to have, and far off. For the pilot, Hobby is sufficient.

## 5. Turn on the optional safety/ops features (recommended)
Set these env vars in Vercel (all optional — each is a no-op if unset):
- **CAPTCHA:** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (Cloudflare dashboard → **Turnstile → Add widget** → copy the Sitekey + Secret). **Also enable native CAPTCHA** in Supabase → **Authentication → Settings → "Bot and Abuse Protection"** → *Enable CAPTCHA protection* → choose **Turnstile** → paste the secret (✏️ *corrected path — it lives under Auth Settings, not a top-level menu*). The app already forwards the token to Supabase, so this makes CAPTCHA enforced on *every* signup path — including a direct anon `signUp` — not just the app's own form. *(Gating — paused/invite/.edu — is already DB-enforced and bypass-proof without this; native CAPTCHA closes the bot-signup vector in `open` mode.)*
- **Error monitoring:** `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (+ `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` for source maps).
- **Cron alerting:** `CRON_HEARTBEAT_SCHEDULER_URL`, `CRON_HEARTBEAT_NUDGE_URL`, `CRON_HEARTBEAT_MAINTENANCE_URL` (Healthchecks.io — create one check per cron, with the expected schedule).
- **Operator console:** `OPERATOR_SECRET` (long random string).
- **Uptime:** point an external monitor (Healthchecks.io / UptimeRobot) at `https://<domain>/api/health`.

## 6. Decisions to make (then I wire/confirm)
- **Signup gate:** default `open`. To restrict, in SQL: `update app_config set signup_mode='invite';` (then `insert into invite_codes(code) values ('CODE');`) or `update app_config set signup_mode='edu', allowed_email_domains='{edu}';`.
- **Backups:** the free tier has **no PITR and no automated daily backups** (both start on Supabase Pro) — this is the one real free-tier *limitation* (not a charge). For a small pilot it's an accepted risk; mitigate by exporting your DB occasionally (`pg_dump`) and writing down a rollback plan. Upgrade Supabase only when your data is worth guaranteed backups.
- **Legal:** fill the real values in `lib/legal.ts` (`COMPANY_NAME`, `CONTACT_EMAIL`, `GOVERNING_LAW`) and remove the amber operator-note block in `app/legal/privacy/page.tsx` after confirming each AI provider's data-retention posture. Have counsel review the Terms/Privacy/AUP before public launch.
- **Data API exposure:** now at Supabase → **Integrations → Data API → Settings** (✏️ *moved from Settings → API*). **Good news for Cogni — nothing to do here:** the app never uses the public Data API (every table query is server-side via the service-role key; the browser only does auth). So Supabase's 2026 change — public tables are no longer auto-exposed to `anon`/`authenticated` (default for new projects since May 30 2026; all projects Oct 30 2026) — **does not affect Cogni** and actually shrinks its attack surface. *(Verified against the code: no browser-side table queries, no reliance on anon/authenticated grants.)*

## 7. Pre-launch verification (on prod, not local)
- Run the test suite against prod config.
- Re-verify tenant isolation on the **prod** Data API: as `anon`, `POST /rest/v1/rpc/get_user_api_key` must return "permission denied."
- Fresh-stranger smoke run on the deployed URL: signup → onboard → upload → tutor → review → export data (Settings → "Export my data") → delete account. *(In the no-email pilot there's no confirmation step — signup auto-logs-in. Only expect a "confirm your email" step if you turned email confirmation back on.)*
- Confirm both crons fire on prod (scheduler 05:00, nudge 06:00 UTC) and the maintenance cron (Sun 04:00).
- **Soft-launch** to a small invited cohort; watch week 1; then open public signup.

---

## Operator runbook (incident response, all via SQL editor or `/api/operator`)

| Action | How |
|---|---|
| **Pause all signups** | `update app_config set signups_paused = true;` (effective ≤10s, no redeploy) |
| **Hard-stop all AI** (cost/abuse spike) | `update app_config set ai_disabled = true;` |
| **Go invite-only** | `update app_config set signup_mode='invite';` then `insert into invite_codes(code) values ('ABC123');` |
| **Suspend a user** | `POST /api/operator` with header `x-operator-secret: <OPERATOR_SECRET>`, body `{"userId":"…","suspended":true,"reason":"…"}` |
| **Reset a user's password** (no-email recovery) | `POST /api/operator` with the same header, body `{"userId":"…","setPassword":"<new-password>"}` (min **8 chars**) — sets it directly via the Admin API and audits it. This is the recovery path when self-serve reset is off. *(You can also do it in Supabase → Authentication → Users.)* |
| **Review activity** | `GET /api/operator` (recent audit log + suspended users), or read `audit_log` in SQL |
| **Tune AI caps** | edit `DAILY_LIMITS` in `lib/rate-limit.ts` (redeploy) |

Re-enable by setting the flags back to `false`.
