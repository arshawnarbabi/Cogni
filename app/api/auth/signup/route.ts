import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getAppConfig, auditLog } from '@/lib/app-config'
import { verifyTurnstile } from '@/lib/captcha'
import { LEGAL_VERSION } from '@/lib/legal'
import { apiError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

// Server-side signup so gating (open/invite/.edu), CAPTCHA, the signups-paused
// kill-switch, and consent recording are actually ENFORCED — a client cannot
// bypass them by calling supabase.auth.signUp directly. Email confirmation (when
// enabled in the Supabase dashboard) still works: the anon-key signUp here sends
// the confirmation email exactly as the client call did.

type Body = {
  email?: string
  password?: string
  inviteCode?: string
  captchaToken?: string
  acceptedTerms?: boolean
  ageAttested?: boolean
}

function emailDomainAllowed(email: string, allowed: string[]): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (!domain) return false
  // Match an exact domain (mit.edu) or a suffix label (edu → *.edu).
  return allowed.some((a) => {
    const x = a.toLowerCase().replace(/^\*?\.?/, '')
    return domain === x || domain.endsWith(`.${x}`)
  })
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return apiError('bad_request', 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  if (!email || !password) return apiError('missing_credentials', 400)
  if (password.length < 8) return apiError('weak_password', 400)
  if (!body.acceptedTerms || !body.ageAttested) return apiError('consent_required', 400)

  // Read config FRESH (not the 10s cache): signups are low-frequency, and the
  // pre-checks below must reflect an operator's just-made change so the user gets
  // the right error. The DB trigger is the bypass-proof backstop regardless.
  const cfg = await getAppConfig({ fresh: true })
  if (cfg.signupsPaused) return apiError('signups_paused', 403)

  // CAPTCHA (skipped automatically when TURNSTILE_SECRET_KEY is unset).
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!(await verifyTurnstile(body.captchaToken, ip))) {
    return apiError('captcha_failed', 400)
  }

  const service = createServiceClient()
  const inviteCode = (body.inviteCode ?? '').trim()

  // ── Signup gating: fast friendly PRE-checks only ──────────────────────────
  // The real enforcement is the BEFORE INSERT trigger on auth.users (it can't be
  // bypassed by a direct anon signUp or OAuth, and consumes the invite atomically
  // inside the signup transaction). These pre-checks just return nicer errors
  // before we hit the database. Do NOT consume the invite here.
  if (cfg.signupMode === 'edu' && !emailDomainAllowed(email, cfg.allowedEmailDomains)) {
    await auditLog('signup_blocked', { detail: { reason: 'email_not_allowed', email } })
    return apiError('email_not_allowed', 403)
  }
  if (cfg.signupMode === 'invite') {
    if (!inviteCode) return apiError('invite_required', 403)
    // Read-only pre-check (no consume — the trigger consumes atomically) so an
    // obviously-bad code returns a friendly error instead of the generic
    // "Database error" that GoTrue surfaces when the trigger rejects it.
    const { data: code } = await service
      .from('invite_codes')
      .select('code')
      .eq('code', inviteCode)
      .is('used_at', null)
      .maybeSingle()
    if (!code) {
      await auditLog('signup_blocked', { detail: { reason: 'invalid_invite', email } })
      return apiError('invalid_invite', 403)
    }
  }

  // ── Create the account (anon-key signUp → sends confirmation email) ────────
  // invite_code rides in user_metadata so the DB trigger can validate + consume
  // it. captchaToken is forwarded so Supabase's native CAPTCHA (if enabled in the
  // dashboard) is also satisfied — making CAPTCHA bypass-proof.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${appUrl}/auth/callback`,
      captchaToken: body.captchaToken,
      data: {
        tos_version: LEGAL_VERSION,
        privacy_version: LEGAL_VERSION,
        age_attested: true,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      },
    },
  })

  if (error) {
    // Map known cases to stable codes; never echo the raw provider message. The
    // gating trigger surfaces its reason string in the error message.
    const msg = error.message.toLowerCase()
    if (msg.includes('already') || msg.includes('registered')) {
      return apiError('email_exists', 409)
    }
    if (msg.includes('signups_paused')) return apiError('signups_paused', 403)
    if (msg.includes('email_not_allowed')) return apiError('email_not_allowed', 403)
    if (msg.includes('invite_required')) return apiError('invite_required', 403)
    if (msg.includes('invalid_invite')) {
      await auditLog('signup_blocked', { detail: { reason: 'invalid_invite', email } })
      return apiError('invalid_invite', 403)
    }
    if (msg.includes('password')) return apiError('weak_password', 400)
    return apiError('signup_failed', 400, { where: 'auth/signup', cause: error })
  }

  // Supabase returns a user with an empty identities array when the email is
  // already registered. Tell the user clearly so they sign in instead of waiting
  // on a confirmation that never comes. (Trades anti-enumeration for clarity —
  // acceptable for this app's threat model.)
  const user = data.user
  const alreadyRegistered = !!user && Array.isArray(user.identities) && user.identities.length === 0
  if (alreadyRegistered) {
    return apiError('email_exists', 409)
  }
  if (user) {
    // Consent is captured durably at signup in two places already: the auth
    // user_metadata (tos_version/privacy_version/age_attested, set in the signUp
    // options above) and the audit_log event below. It is mirrored into the
    // users.* columns later, in onboarding/complete — the public.users row does not
    // exist yet here (it's created at onboarding; app/page.tsx gates onboarding on
    // that row's existence, so we must NOT create it early), and display_name is
    // NOT NULL, so an upsert here would silently fail anyway.
    await auditLog('signup', { subjectUserId: user.id, detail: { mode: cfg.signupMode, email } })
  }

  // session !== null means email confirmation is OFF (auto-login). The client
  // routes accordingly.
  return NextResponse.json({ ok: true, confirmEmail: data.session === null })
}
