import { runNudgeChecks } from '@/lib/agents/nudge'
import { isValidCronRequest, runForAllUsers } from '@/lib/cron'
import { NextResponse } from 'next/server'

// Cron processes every user with bounded concurrency; needs > the 60s Hobby cap
// (Vercel Pro). Ignored locally.
export const maxDuration = 300

// Vercel Cron Job handler — called daily at 06:00 UTC via vercel.json.
// Vercel cron issues a GET with an Authorization header carrying CRON_SECRET.
// Runs nudge checks for ALL users, paginated + concurrency-capped.
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { total, failed } = await runForAllUsers((userId) => runNudgeChecks(userId))
  if (failed > 0) console.error(`[nudge cron] ${failed}/${total} users failed`)
  return NextResponse.json({ ok: true, count: total, failed })
}
