import { timingSafeEqual } from 'node:crypto'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/server'

export function isValidCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const provided = request.headers.get('authorization')
  const expected = `Bearer ${secret}`
  // Constant-time comparison so a response-timing side channel can't be used to
  // recover the secret byte-by-byte. Length-guard first (timingSafeEqual throws
  // on length mismatch); the length of "Bearer <secret>" is not itself secret.
  if (!provided || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

/**
 * Run `task` for every user. Paginates past PostgREST's ~1000-row default cap
 * (so users beyond 1000 are never skipped) and processes each page with a
 * bounded concurrency so a large user base can't trigger a thundering herd
 * (DB connections + external-API bursts) or blow the serverless time budget.
 * Per-user failures are isolated + counted; they never abort the whole run.
 */
export async function runForAllUsers(
  task: (userId: string) => Promise<void>,
  { concurrency = 5, pageSize = 1000 }: { concurrency?: number; pageSize?: number } = {}
): Promise<{ total: number; failed: number }> {
  const service = createServiceClient()
  let offset = 0
  let total = 0
  let failed = 0
  for (;;) {
    const { data: users } = await service
      .from('users')
      .select('user_id')
      .range(offset, offset + pageSize - 1)
    if (!users || users.length === 0) break
    for (let i = 0; i < users.length; i += concurrency) {
      const chunk = users.slice(i, i + concurrency)
      const results = await Promise.allSettled(
        chunk.map((u: { user_id: string }) => task(u.user_id))
      )
      for (const r of results) {
        total++
        if (r.status === 'rejected') {
          failed++
          console.error('[cron] task failed for a user', r.reason)
          // Visible in prod (R14): a spike of per-user cron failures was
          // previously console-only, i.e. invisible.
          Sentry.captureException(r.reason, { tags: { surface: 'cron' } })
        }
      }
    }
    if (users.length < pageSize) break
    offset += pageSize
  }
  return { total, failed }
}
