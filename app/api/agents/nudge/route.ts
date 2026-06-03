import { createServiceClient } from '@/lib/supabase/server'
import { runNudgeChecks } from '@/lib/agents/nudge'
import { isValidCronRequest } from '@/lib/cron'
import { NextResponse } from 'next/server'

// Vercel Cron Job handler — called daily at 06:00 UTC via vercel.json.
// Vercel cron issues a GET with an Authorization header carrying CRON_SECRET.
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: users } = await service.from('users').select('user_id')

  if (!users) return NextResponse.json({ ok: true, count: 0 })

  let count = 0
  for (const user of users) {
    try {
      await runNudgeChecks(user.user_id)
      count++
    } catch (e) {
      console.error(`[nudge cron] failed for user ${user.user_id}`, e)
    }
  }

  return NextResponse.json({ ok: true, count })
}
