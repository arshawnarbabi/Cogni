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

  // Pull a bit more than a session's worth, then order by topic importance below.
  const { data: cards } = await query.limit(80)

  if (!cards || cards.length === 0) {
    redirect(courseId ? '/courses' : '/today')
  }

  type ReviewCardRow = { card_id: string; front: string; back: string; hint: string | null; topic_id: string | null }
  const cardRows = cards as ReviewCardRow[]

  // Front-load the session by priority — high professor_weight × low mastery first —
  // so if the student only finishes part of it, they've covered the highest-leverage
  // material. Ties fall back to the due-date order from the query.
  const topicIds = [...new Set(cardRows.map(c => c.topic_id).filter(Boolean) as string[])]
  const weightByTopic = new Map<string, number>()
  const masteryByTopic = new Map<string, number>()
  if (topicIds.length > 0) {
    const [tw, tm] = await Promise.all([
      service.from('topics').select('topic_id, professor_weight').in('topic_id', topicIds),
      service.from('topic_mastery').select('topic_id, mastery_score').eq('user_id', user.id).in('topic_id', topicIds),
    ])
    for (const t of (tw.data ?? []) as { topic_id: string; professor_weight: number | null }[]) {
      weightByTopic.set(t.topic_id, Number(t.professor_weight ?? 0.5))
    }
    for (const m of (tm.data ?? []) as { topic_id: string; mastery_score: number | null }[]) {
      masteryByTopic.set(m.topic_id, Number(m.mastery_score ?? 0))
    }
  }
  const cardPriority = (c: ReviewCardRow): number => {
    const w = c.topic_id ? (weightByTopic.get(c.topic_id) ?? 0.5) : 0.4
    const ms = c.topic_id ? (masteryByTopic.get(c.topic_id) ?? 0) : 0
    return w * (1 - ms)
  }
  const ordered = cardRows
    .map((c, i) => ({ c, i, p: cardPriority(c) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .slice(0, 50)
    .map(x => x.c)

  return <ReviewClient cards={ordered} />
}
