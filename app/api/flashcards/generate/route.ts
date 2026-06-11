import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runFlashcardAgent } from '@/lib/agents/flashcard'
import { aiRouteGuard } from '@/lib/rate-limit'
import { readJson, badRequest } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{ courseId: string; topicId: string }>(request)
  if (!body) return badRequest('invalid_json')
  const { courseId, topicId } = body
  if (!courseId || !topicId) return NextResponse.json({ error: 'Missing courseId or topicId' }, { status: 400 })

  // Cheap ownership/existence check BEFORE the quota burn (same ordering as
  // inbox/items/[itemId]/retry): a bad/stale topicId is a 404, not a wasted
  // daily flashcards unit.
  const service = createServiceClient()
  const { data: topic } = await service
    .from('topics')
    .select('topic_id')
    .eq('topic_id', topicId)
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!topic) return NextResponse.json({ error: 'Topic not found' }, { status: 404 })

  // Reject suspended accounts + enforce the daily flashcards cap — only after
  // the cheap checks above, so a 400/404 never burns a quota unit.
  const guard = await aiRouteGuard(user.id, 'flashcards')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const result = await runFlashcardAgent(user.id, courseId, topicId)

  if (result.error && result.generated === 0) {
    // A missing BYOK key is an expected user state (402, like the tutor route), not a
    // server fault — don't report it as a 5xx.
    const status = result.error === 'No API key configured' ? 402 : 500
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({ ok: true, generated: result.generated })
}
