import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'

// ─────────────────────────────────────────────────────────────────────────────
// Shared retry/backoff + key-health wrapper for ALL model/embedding calls (R1+R5).
//
// Previously every Anthropic/OpenAI call in the codebase was a single shot: a
// transient 529 overloaded_error made the profiler "succeed" with zero topics,
// dropped RAG grounding silently, or failed a whole upload classification.
// withRetry() turns the dominant class of transient AI failures into successes,
// fails FAST on terminal errors (a bad key must not retry 3×), and — when given
// key-health context — records provider auth/credit failures on the user row so
// the UI can say "your key is broken" instead of mysteriously degrading (R5).
// ─────────────────────────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai'

export type RetryOpts = {
  /** Total attempts (default 3). */
  retries?: number
  baseMs?: number
  maxMs?: number
  /** Label for logs/Sentry, e.g. 'profiler.extract'. */
  label?: string
  /** When set: terminal auth/credit failures mark this user's provider key
   *  unhealthy; a success clears a previously-recorded failure. */
  keyHealth?: { userId: string; provider: Provider }
}

export type KeyStatus = 'ok' | 'invalid' | 'no_credits'

function statusOf(e: unknown): number | null {
  const any = e as { status?: number; statusCode?: number; response?: { status?: number } }
  return any?.status ?? any?.statusCode ?? any?.response?.status ?? null
}

function retryAfterMs(e: unknown): number | null {
  const headers = (e as { headers?: Record<string, string> | Headers })?.headers
  let v: string | null | undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) v = headers.get('retry-after')
  else if (headers && typeof headers === 'object') v = (headers as Record<string, string>)['retry-after']
  const s = Number(v)
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 30_000) : null
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET'])

export function isRetryable(e: unknown): boolean {
  const status = statusOf(e)
  // 408 timeout, 429 rate limit, 5xx (incl. Anthropic 529 overloaded_error).
  if (status != null) return status === 408 || status === 429 || status >= 500
  const code = (e as { code?: string })?.code ?? ''
  if (RETRYABLE_CODES.has(code)) return true
  const msg = e instanceof Error ? e.message : ''
  return /fetch failed|network|socket|terminated|aborted|other side closed/i.test(msg)
}

// Distinguish "this key is broken" (user must act) from transient noise.
export function keyFailureKind(e: unknown): Exclude<KeyStatus, 'ok'> | null {
  const status = statusOf(e)
  if (status === 401 || status === 403) return 'invalid'
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase()
  if (status === 402 || /insufficient_quota|credit balance|billing|exceeded your current quota|payment required/.test(msg)) {
    return 'no_credits'
  }
  return null
}

const STATUS_COL: Record<Provider, string> = {
  anthropic: 'anthropic_key_status',
  openai: 'openai_key_status',
}

/** Record key health on the users row (fire-and-forget; never blocks the caller). */
export function markKeyStatus(userId: string, provider: Provider, status: KeyStatus): void {
  const service = createServiceClient()
  void service
    .from('users')
    .update({ [STATUS_COL[provider]]: status === 'ok' ? null : status })
    .eq('user_id', userId)
    .then(() => {}, (e: unknown) => console.error('[ai] markKeyStatus failed', e))
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3
  const baseMs = opts.baseMs ?? 500
  const maxMs = opts.maxMs ?? 8000
  const label = opts.label ?? 'ai-call'

  let lastError: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn()
      // Success clears a previously-recorded key failure so the "your key is
      // broken" banner self-heals the moment the key works again.
      if (opts.keyHealth) markKeyStatus(opts.keyHealth.userId, opts.keyHealth.provider, 'ok')
      return result
    } catch (e) {
      lastError = e

      // Terminal key problems: record + fail fast (retrying a revoked key 3× is noise).
      const keyFailure = keyFailureKind(e)
      if (keyFailure && opts.keyHealth) {
        markKeyStatus(opts.keyHealth.userId, opts.keyHealth.provider, keyFailure)
      }
      if (!isRetryable(e) || attempt === retries) break

      // Full-jitter exponential backoff; honor provider retry-after when present.
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const delay = retryAfterMs(e) ?? Math.random() * cap
      console.warn(`[${label}] attempt ${attempt}/${retries} failed (retrying in ${Math.round(delay)}ms)`, statusOf(e) ?? (e instanceof Error ? e.message : e))
      await sleep(delay)
    }
  }

  // Retries exhausted or terminal: surface to Sentry with context, then rethrow.
  Sentry.captureException(lastError, {
    tags: { surface: label, retryable: String(isRetryable(lastError)) },
  })
  throw lastError
}
