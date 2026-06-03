# Cogni — Deployment Runbook (manual `[you]` steps)

All the **code-side** production-readiness work is done on the `hosted-migration` branch.
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
2. **Enable the `supabase_vault` extension** (Database → Extensions) **before** running SQL — BYOK breaks without it.
3. Run **`supabase/setup.sql`** once in the SQL editor (it bundles sections 1–10, idempotent).
4. **Verify:** RLS `on` for every table; the 4 storage buckets exist; the Vault / `review_card_atomic` RPCs are **not** granted to `anon`.

## 2. Email (do before turning on confirmation)
1. Create a **Resend** account + verify a sending domain (set SPF/DKIM/DMARC).
2. Supabase Dashboard → Authentication → Emails → **SMTP**: host `smtp.resend.com`, port `465`, user `resend`, pass = Resend API key, sender = an address on your verified domain.
3. Send a **real test email** and confirm it lands in a Gmail/Outlook **inbox, not spam**.
4. Authentication → Providers → Email → **turn ON "Confirm email."**

## 3. Google OAuth (optional but recommended)
- Supabase → Authentication → Providers → Google: add client ID/secret from Google Cloud, and set the redirect URI to `https://<your-domain>/auth/callback`.

## 4. Vercel — FREE (Hobby) plan is enough
1. Import the repo, deploy from `hosted-migration` (or merge to `main` first).
2. **Stay on Hobby (free).** Ensure **Fluid Compute is enabled** (Settings → Functions — it's the default). With Fluid Compute, Hobby allows `maxDuration` up to **300s**, so the crons run fine — *no Pro upgrade needed.* (Cron limits on Hobby: up to 100 jobs/project, once-per-day max frequency, fired within the scheduled hour — all of which our 2 daily + 1 weekly crons satisfy.)
3. Set env vars (Production scope) per `.env.example`. **Required:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`. Confirm `MOCK_AGENTS` is **unset**.
4. Attach your **custom domain** (free on Hobby); set `NEXT_PUBLIC_APP_URL` to it (build-time-baked, so set before the prod build).
5. Supabase → Authentication → URL Configuration: set **Site URL** + redirect URLs to the prod domain.

> **Upgrade to Pro only later, if** a cron starts hitting the 300s wall (i.e. you have so many users that one daily run can't finish in 5 minutes) — that's a good problem to have, and far off. For the pilot, Hobby is sufficient.

## 5. Turn on the optional safety/ops features (recommended)
Set these env vars in Vercel (all optional — each is a no-op if unset):
- **CAPTCHA:** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile). **Also enable native CAPTCHA** in Supabase → Authentication → Bot & Abuse Protection (paste the same Turnstile secret). The app already forwards the token to Supabase, so this makes CAPTCHA enforced on *every* signup path — including a direct anon `signUp` — not just the app's own form. *(Gating — paused/invite/.edu — is already DB-enforced and bypass-proof without this; native CAPTCHA closes the bot-signup vector in `open` mode.)*
- **Error monitoring:** `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (+ `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` for source maps).
- **Cron alerting:** `CRON_HEARTBEAT_SCHEDULER_URL`, `CRON_HEARTBEAT_NUDGE_URL`, `CRON_HEARTBEAT_MAINTENANCE_URL` (Healthchecks.io — create one check per cron, with the expected schedule).
- **Operator console:** `OPERATOR_SECRET` (long random string).
- **Uptime:** point an external monitor (Healthchecks.io / UptimeRobot) at `https://<domain>/api/health`.

## 6. Decisions to make (then I wire/confirm)
- **Signup gate:** default `open`. To restrict, in SQL: `update app_config set signup_mode='invite';` (then `insert into invite_codes(code) values ('CODE');`) or `update app_config set signup_mode='edu', allowed_email_domains='{edu}';`.
- **Backups:** the free tier has **no PITR and limited/no automated backups** — this is the one real free-tier *limitation* (not a charge). For a small pilot it's an accepted risk; mitigate by exporting your DB occasionally (`pg_dump`) and writing down a rollback plan. Upgrade Supabase only when your data is worth guaranteed backups.
- **Legal:** fill the real values in `lib/legal.ts` (`COMPANY_NAME`, `CONTACT_EMAIL`, `GOVERNING_LAW`) and remove the amber operator-note block in `app/legal/privacy/page.tsx` after confirming each AI provider's data-retention posture. Have counsel review the Terms/Privacy/AUP before public launch.
- **Data API exposure:** in Supabase → Settings → API, confirm which schemas are exposed via the public Data API.

## 7. Pre-launch verification (on prod, not local)
- Run the test suite against prod config.
- Re-verify tenant isolation on the **prod** Data API: as `anon`, `POST /rest/v1/rpc/get_user_api_key` must return "permission denied."
- Fresh-stranger smoke run on the deployed URL: signup → confirm email → onboard → upload → tutor → review → export data → delete account.
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
| **Review activity** | `GET /api/operator` (recent audit log + suspended users), or read `audit_log` in SQL |
| **Tune AI caps** | edit `DAILY_LIMITS` in `lib/rate-limit.ts` (redeploy) |

Re-enable by setting the flags back to `false`.
