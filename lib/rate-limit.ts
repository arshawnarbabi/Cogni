import { createServiceClient } from '@/lib/supabase/server'
import { getAppConfig } from '@/lib/app-config'

// Default daily caps for the expensive AI routes (BYOK covers the model cost, but
// these bound abuse and protect the shared free-tier Supabase/Vercel project from
// scripted hammering). Tune as needed.
export const DAILY_LIMITS = {
  audio_overview: 5,
  simulated_exam: 10,
  practice_quiz: 20,
  flashcards: 30,
  profiler: 15,       // syllabus analysis — onboarding + course-create + inbox + web-suggestion (Sonnet x2 per run)
  inbox_classify: 40, // per-upload material classification
  web_enrichment: 5,  // web-search syllabus enrichment — most expensive path (Sonnet + web_search, up to 4 iterations)
  grade: 40,          // short-answer grading fan-out (Haiku per question) — serves practice_quiz + simulated_exam
  mcp_read: 500,      // MCP read tools (cheap DB queries; generous — a long tutoring session reads a lot)
  mcp_write: 60,      // MCP write tools (create_flashcards etc.) — bounds an unattended/abused token
} as const

export type AiAction = keyof typeof DAILY_LIMITS

// Fallback daily message cap for the Tutor when a user has no explicit
// users.daily_message_limit set. Previously null meant "unlimited", which left
// the Tutor — the most-used AI route — entirely uncapped.
export const DEFAULT_TUTOR_DAILY_LIMIT = 100

// Ceiling on the SELF-SET tutor limit (settings/tutor-limit). Without an upper
// bound a user could PATCH a huge value and recreate the uncapped state the
// default above was added to close.
export const MAX_TUTOR_DAILY_LIMIT = 500

/** Increment the user's daily counter for `action`; true if still within `limit`. Fails open on infra error. */
async function consumeDaily(userId: string, action: string, limit: number): Promise<boolean> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('consume_daily_quota', { p_user_id: userId, p_action: action, p_limit: limit })
  if (error) {
    console.error('[rate-limit] consume_daily_quota error', error)
    return true // never block a real user because the limiter itself failed
  }
  return data === true
}

/** True if the account is suspended. Fails open (false) on infra error. */
export async function isUserSuspended(userId: string): Promise<boolean> {
  const service = createServiceClient()
  const { data } = await service.from('users').select('suspended').eq('user_id', userId).maybeSingle()
  return data?.suspended === true
}

/**
 * Consume one unit of the per-user daily quota for an AI action. Returns true if
 * the call is allowed (still within the cap), false if exhausted.
 *
 * Use this (rather than `aiRouteGuard`) when the route must check the user's API
 * key BETWEEN the suspended check and the quota burn — so a keyless request, or
 * a path that should degrade gracefully, doesn't waste the user's daily allowance.
 */
export async function consumeAiQuota(userId: string, action: AiAction): Promise<boolean> {
  // Global kill-switch: when AI is disabled, treat as "no allowance" so the
  // graceful-skip callers (onboarding, course-create, inbox, web-suggestion)
  // skip the AI work instead of running it.
  if ((await getAppConfig()).aiDisabled) return false
  return consumeDaily(userId, action, DAILY_LIMITS[action])
}

/**
 * Guard for an expensive AI route: rejects suspended accounts and enforces the
 * per-user daily cap in one call. Returns an error descriptor to return, or null
 * to proceed. Order: suspended check first (free), then quota consume.
 */
export async function aiRouteGuard(userId: string, action: AiAction): Promise<{ error: string; status: number } | null> {
  if (await isUserSuspended(userId)) return { error: 'Account suspended.', status: 403 }
  // Global kill-switch (operator flips app_config.ai_disabled): hard-stop every
  // hard-guarded AI route with a clear 503 before consuming quota. Read FRESH so
  // the emergency switch takes effect immediately, not after the cache TTL — the
  // AI call this gates is far slower than a single-row config read.
  if ((await getAppConfig({ fresh: true })).aiDisabled) {
    return { error: 'AI features are temporarily unavailable. Please try again later.', status: 503 }
  }
  if (!(await consumeAiQuota(userId, action))) {
    return { error: 'Daily limit reached for this feature. Try again tomorrow.', status: 429 }
  }
  return null
}
