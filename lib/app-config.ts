import { createServiceClient } from '@/lib/supabase/server'

// Runtime operational config, stored in the public.app_config singleton row and
// read here with a short in-process cache. Lets an operator pause signups,
// hard-disable AI, or change the signup gate from the SQL editor / operator
// route WITHOUT a redeploy (flips take effect within CONFIG_TTL_MS).

export type SignupMode = 'open' | 'invite' | 'edu'

export type AppConfig = {
  signupsPaused: boolean
  aiDisabled: boolean
  signupMode: SignupMode
  allowedEmailDomains: string[]
}

const DEFAULT_CONFIG: AppConfig = {
  signupsPaused: false,
  aiDisabled: false,
  signupMode: 'open',
  allowedEmailDomains: [],
}

const CONFIG_TTL_MS = 10_000

let cache: { value: AppConfig; at: number } | null = null

export async function getAppConfig(opts?: { fresh?: boolean }): Promise<AppConfig> {
  const now = Date.now()
  if (!opts?.fresh && cache && now - cache.at < CONFIG_TTL_MS) return cache.value
  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from('app_config')
      .select('signups_paused, ai_disabled, signup_mode, allowed_email_domains')
      .eq('id', true)
      .maybeSingle()
    if (error || !data) {
      // Table missing (section 10 not yet applied) or empty → safe defaults.
      const value = cache?.value ?? DEFAULT_CONFIG
      cache = { value, at: now }
      return value
    }
    const value: AppConfig = {
      signupsPaused: data.signups_paused === true,
      aiDisabled: data.ai_disabled === true,
      signupMode: (['open', 'invite', 'edu'] as const).includes(data.signup_mode) ? data.signup_mode : 'open',
      allowedEmailDomains: Array.isArray(data.allowed_email_domains) ? data.allowed_email_domains : [],
    }
    cache = { value, at: now }
    return value
  } catch {
    // Never let a config-read failure break a request — fall back to last-known.
    return cache?.value ?? DEFAULT_CONFIG
  }
}

/** Force the next getAppConfig() to re-read (e.g. right after an operator flip). */
export function invalidateAppConfigCache(): void {
  cache = null
}

/**
 * Append a security-relevant event to public.audit_log. Best-effort: never
 * throws into the caller (an audit-write failure must not break the operation
 * being audited).
 */
export async function auditLog(
  action: string,
  opts: { actor?: string; subjectUserId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const service = createServiceClient()
    await service.from('audit_log').insert({
      actor: opts.actor ?? 'system',
      action,
      subject_user_id: opts.subjectUserId ?? null,
      detail: opts.detail ?? {},
    })
  } catch (e) {
    console.error('[audit] write failed', action, e)
  }
}
