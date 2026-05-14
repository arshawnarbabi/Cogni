import { createClient, createServiceClient } from '@/lib/supabase/server'
import { addDaysToDateKey, dateKeyInTimeZone } from '@/lib/time'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: row } = await service
    .from('users')
    .select('study_streak, last_study_date, timezone')
    .eq('user_id', user.id)
    .single()

  if (!row) return NextResponse.json({ ok: true })

  const today = dateKeyInTimeZone(new Date(), row.timezone ?? 'UTC')
  const yesterday = addDaysToDateKey(today, -1)

  // Already updated today
  if (row.last_study_date === today) return NextResponse.json({ ok: true, streak: row.study_streak })

  const newStreak = row.last_study_date === yesterday
    ? (row.study_streak ?? 0) + 1  // consecutive day
    : 1                              // streak broken, restart

  const { error } = await service
    .from('users')
    .update({ study_streak: newStreak, last_study_date: today })
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, streak: newStreak })
}
