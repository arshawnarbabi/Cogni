import { createServiceClient } from '@/lib/supabase/server'

// Default daily caps for the expensive AI routes (BYOK covers cost, but these
// bound abuse + protect the shared free-tier project). Tune as needed.
export const DAILY_LIMITS = {
  audio_overview: 5,
  simulated_exam: 10,
  practice_quiz: 20,
  flashcards: 30,
} as const

export type AiAction = keyof typeof DAILY_LIMITS

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

async function isSuspended(userId: string): Promise<boolean> {
  const service = createServiceClient()
  const { data } = await service.from('users').select('suspended').eq('user_id', userId).maybeSingle()
  return data?.suspended === true
}

/**
 * Guard for an expensive AI route: rejects suspended accounts and enforces the
 * per-user daily cap. Returns an error descriptor to return, or null to proceed.
 */
export async function aiRouteGuard(userId: string, action: AiAction): Promise<{ error: string; status: number } | null> {
  if (await isSuspended(userId)) return { error: 'Account suspended.', status: 403 }
  if (!(await consumeDaily(userId, action, DAILY_LIMITS[action]))) {
    return { error: 'Daily limit reached for this feature. Try again tomorrow.', status: 429 }
  }
  return null
}
