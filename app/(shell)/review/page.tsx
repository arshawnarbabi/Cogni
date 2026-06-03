import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ReviewClient } from './_client'
import { dateKeyInTimeZone } from '@/lib/time'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{ topic?: string; course?: string }>

export default async function ReviewPage({ searchParams }: { searchParams: SearchParams }) {
  const { topic: topicId, course: courseId } = await searchParams

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()
  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', user.id)
    .single()
  const today = dateKeyInTimeZone(new Date(), userRow?.timezone ?? 'UTC')

  let query = service
    .from('flashcards')
    .select('card_id, front, back, hint, topic_id, course_id, fsrs_stability, fsrs_difficulty, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_last_review, fsrs_next_review_date')
    .eq('user_id', user.id)
    .lte('fsrs_next_review_date', today)
    .order('fsrs_next_review_date', { ascending: true })

  if (topicId) {
    query = query.eq('topic_id', topicId)
  } else if (courseId) {
    query = query.eq('course_id', courseId)
  }

  const { data: cards } = await query.limit(50)

  if (!cards || cards.length === 0) {
    redirect(courseId ? '/courses' : '/today')
  }

  return <ReviewClient cards={cards} />
}
