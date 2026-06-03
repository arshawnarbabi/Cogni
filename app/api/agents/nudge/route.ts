import { runNudgeChecks } from '@/lib/agents/nudge'
import { isValidCronRequest, runForAllUsers } from '@/lib/cron'
import { pingHeartbeat } from '@/lib/heartbeat'
import { NextResponse } from 'next/server'

// Cron processes every user with bounded concurrency. 300s is allowed on Vercel
// Hobby (free) when Fluid Compute is enabled (the default); no Pro plan needed.
// Ignored locally.
export const maxDuration = 300

// Vercel Cron Job handler — called daily at 06:00 UTC via vercel.json.
// Vercel cron issues a GET with an Authorization header carrying CRON_SECRET.
// Runs nudge checks for ALL users, paginated + concurrency-capped.
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { total, failed } = await runForAllUsers((userId) => runNudgeChecks(userId))
    if (failed > 0) console.error(`[nudge cron] ${failed}/${total} users failed`)
    await pingHeartbeat(process.env.CRON_HEARTBEAT_NUDGE_URL, failed === 0)
    return NextResponse.json({ ok: true, count: total, failed })
  } catch (e) {
    await pingHeartbeat(process.env.CRON_HEARTBEAT_NUDGE_URL, false)
    throw e
  }
}
