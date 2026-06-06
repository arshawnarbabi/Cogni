import { createServiceClient } from '@/lib/supabase/server'
import { addDaysToDateKey, dateKeyInTimeZone } from '@/lib/time'

// Shared streak bump used by the /api/user/streak route AND the MCP
// log_study_session tool (X3), so studying through the student's own Claude
// keeps their streak alive exactly like in-app study does.
export async function bumpStudyStreak(userId: string): Promise<number | null> {
  const service = createServiceClient()

  const { data: row } = await service
    .from('users')
    .select('study_streak, last_study_date, timezone')
    .eq('user_id', userId)
    .maybeSingle()
  if (!row) return null

  const today = dateKeyInTimeZone(new Date(), row.timezone ?? 'UTC')
  const yesterday = addDaysToDateKey(today, -1)

  // Already counted today.
  if (row.last_study_date === today) return row.study_streak ?? 0

  const newStreak = row.last_study_date === yesterday
    ? (row.study_streak ?? 0) + 1  // consecutive day
    : 1                            // streak broken, restart

  const { error } = await service
    .from('users')
    .update({ study_streak: newStreak, last_study_date: today })
    .eq('user_id', userId)
  if (error) {
    console.error('[streak] update failed', error)
    return null
  }
  return newStreak
}
