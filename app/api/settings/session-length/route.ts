import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runScheduler } from '@/lib/agents/scheduler'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionLength } = await request.json() as { sessionLength: number }
  if (![25, 45, 90].includes(sessionLength)) {
    return NextResponse.json({ error: 'Invalid sessionLength' }, { status: 400 })
  }

  const service = createServiceClient()
  const { error } = await service.from('users').update({ session_length_preference: sessionLength }).eq('user_id', user.id)
  if (error) return serverError('settings/session-length PATCH', error)

  // Rerun scheduler so daily plan uses the updated session length
  runScheduler(user.id).catch(e =>
    console.error('[settings/session-length] runScheduler failed', e)
  )

  return NextResponse.json({ ok: true })
}
