import { createClient } from '@/lib/supabase/server'
import { runScheduler } from '@/lib/agents/scheduler'
import { isValidCronRequest } from '@/lib/cron'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await runScheduler(user.id)
  return NextResponse.json({ ok: true })
}

// Vercel Cron Job handler — called daily at 05:00 UTC
// All active users: query users table and run scheduler for each
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { createServiceClient } = await import('@/lib/supabase/server')
  const service = createServiceClient()
  const { data: users } = await service.from('users').select('user_id')

  if (!users) return NextResponse.json({ ok: true, ran: 0 })

  await Promise.allSettled(users.map((u: { user_id: string }) => runScheduler(u.user_id)))
  return NextResponse.json({ ok: true, ran: users.length })
}
