import { createClient } from '@/lib/supabase/server'
import { runScheduler } from '@/lib/agents/scheduler'
import { isValidCronRequest, runForAllUsers } from '@/lib/cron'
import { NextResponse } from 'next/server'

// Cron processes every user with bounded concurrency; needs > the 60s Hobby cap.
// Requires a Vercel plan that allows longer functions (Pro). Ignored locally.
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

  const { total, failed } = await runForAllUsers((userId) => runScheduler(userId))
  if (failed > 0) console.error(`[scheduler cron] ${failed}/${total} users failed`)
  return NextResponse.json({ ok: true, ran: total, failed })
}
