import { createClient } from '@/lib/supabase/server'
import { bumpStudyStreak } from '@/lib/streak'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Shared logic with the MCP log_study_session tool (lib/streak.ts).
  const streak = await bumpStudyStreak(user.id)
  if (streak === null) return NextResponse.json({ ok: true })
  return NextResponse.json({ ok: true, streak })
}
