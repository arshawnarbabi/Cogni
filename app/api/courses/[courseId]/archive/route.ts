import { createClient, createServiceClient } from '@/lib/supabase/server'
import { dateKeyInTimeZone } from '@/lib/time'
import { NextResponse } from 'next/server'
import { serverError } from '@/lib/api-error'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params
  const { keepFlashcards, keepProfessor } = await request.json() as {
    keepFlashcards: boolean
    keepProfessor: boolean
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: course } = await service
    .from('courses')
    .select('course_id, professor_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  if (!course) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: topics } = await service
    .from('topics')
    .select('topic_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)

  const topicIds = (topics ?? []).map((t: { topic_id: string }) => t.topic_id)

  if (topicIds.length > 0) {
    if (keepFlashcards) {
      const now = new Date()
      const { data: cards } = await service
        .from('flashcards')
        .select('card_id, fsrs_next_review_date')
        .in('topic_id', topicIds)
        .eq('user_id', user.id)

      for (const card of cards ?? []) {
        const currentDue = new Date(card.fsrs_next_review_date)
        const msUntilDue = Math.max(0, currentDue.getTime() - now.getTime())
        const newDue = new Date(now.getTime() + msUntilDue * 2)
        await service
          .from('flashcards')
          .update({ fsrs_next_review_date: newDue.toISOString().split('T')[0] })
          .eq('card_id', card.card_id)
          .eq('user_id', user.id)
      }
    } else {
      await service
        .from('flashcards')
        .update({ fsrs_next_review_date: '9999-01-01' })
        .in('topic_id', topicIds)
        .eq('user_id', user.id)
    }
  }

  if (!keepProfessor && course.professor_id) {
    await service.storage
      .from('wiki')
      .remove([`${user.id}/professor_${course.professor_id}.md`])
  }

  const { error: archiveError } = await service
    .from('courses')
    .update({ active_status: 'archived' })
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  if (archiveError) return serverError('courses/archive', archiveError)

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: course } = await service
    .from('courses')
    .select('course_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()
  if (!course) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Reactivate all paused flashcards to today
  const { data: topics } = await service
    .from('topics')
    .select('topic_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)

  const topicIds = (topics ?? []).map((t: { topic_id: string }) => t.topic_id)

  if (topicIds.length > 0) {
    const { data: userRow } = await service
      .from('users')
      .select('timezone')
      .eq('user_id', user.id)
      .single()
    const timeZone = userRow?.timezone ?? 'UTC'
    const today = dateKeyInTimeZone(new Date(), timeZone)
    await service
      .from('flashcards')
      .update({ fsrs_next_review_date: today })
      .in('topic_id', topicIds)
      .eq('user_id', user.id)
      .eq('fsrs_next_review_date', '9999-01-01')
  }

  const { error: activateError } = await service
    .from('courses')
    .update({ active_status: 'active' })
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  if (activateError) return serverError('courses/unarchive', activateError)

  return NextResponse.json({ ok: true })
}
