import { createClient } from '@/lib/supabase/server'
import { runScheduler } from '@/lib/agents/scheduler'
import { isValidCronRequest, runForAllUsers } from '@/lib/cron'
import { pingHeartbeat } from '@/lib/heartbeat'
import { NextResponse } from 'next/server'

// Cron processes every user with bounded concurrency. 300s is allowed on Vercel
// Hobby (free) when Fluid Compute is enabled (the default); no Pro plan needed.
// Ignored locally.
export const maxDuration = 300

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await runScheduler(user.id)
  return NextResponse.json({ ok: true })
}

// Vercel Cron Job handler — called daily at 05:00 UTC.
// Runs the scheduler for ALL users, paginated + concurrency-capped.
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { total, failed } = await runForAllUsers((userId) => runScheduler(userId))
    if (failed > 0) console.error(`[scheduler cron] ${failed}/${total} users failed`)
    await pingHeartbeat(process.env.CRON_HEARTBEAT_SCHEDULER_URL, failed === 0)
    return NextResponse.json({ ok: true, ran: total, failed })
  } catch (e) {
    await pingHeartbeat(process.env.CRON_HEARTBEAT_SCHEDULER_URL, false)
    throw e
  }
}
