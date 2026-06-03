import { createClient } from '@/lib/supabase/server'
import { writeStudyBlocksToCalendar } from '@/lib/calendar'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

// Dev-only test endpoint
export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await writeStudyBlocksToCalendar(user.id, [
      { course_name: 'Test Block', duration_minutes: 30, order: 1 },
    ])
    return NextResponse.json({ ok: true, message: 'Calendar write attempted — check your Google Calendar' })
  } catch (err) {
    return serverError('calendar/test', err)
  }
}
