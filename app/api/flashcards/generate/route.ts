import { createClient } from '@/lib/supabase/server'
import { runFlashcardAgent } from '@/lib/agents/flashcard'
import { aiRouteGuard } from '@/lib/rate-limit'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await aiRouteGuard(user.id, 'flashcards')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const { courseId, topicId } = await request.json() as { courseId: string; topicId: string }
  if (!courseId || !topicId) return NextResponse.json({ error: 'Missing courseId or topicId' }, { status: 400 })

  const result = await runFlashcardAgent(user.id, courseId, topicId)

  if (result.error && result.generated === 0) {
    // A missing BYOK key is an expected user state (402, like the tutor route), not a
    // server fault — don't report it as a 5xx.
    const status = result.error === 'No API key configured' ? 402 : 500
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({ ok: true, generated: result.generated })
}
