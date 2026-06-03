import { createClient, createServiceClient } from '@/lib/supabase/server'
import { scheduleReview } from '@/lib/fsrs'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { cardId, rating } = await request.json() as { cardId: string; rating: 1 | 2 | 3 | 4 }

  if (!cardId || ![1, 2, 3, 4].includes(rating)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: card, error: cardError } = await service
    .from('flashcards')
    .select('card_id, topic_id, fsrs_stability, fsrs_difficulty, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_last_review, fsrs_next_review_date')
    .eq('card_id', cardId)
    .eq('user_id', user.id)
    .single()

  if (cardError || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', user.id)
    .single()
  const timeZone = userRow?.timezone ?? 'UTC'

  const next = scheduleReview({
    fsrs_stability: Number(card.fsrs_stability),
    fsrs_difficulty: Number(card.fsrs_difficulty),
    fsrs_reps: card.fsrs_reps,
    fsrs_lapses: card.fsrs_lapses,
    fsrs_state: card.fsrs_state,
    fsrs_last_review: card.fsrs_last_review,
    fsrs_next_review_date: card.fsrs_next_review_date,
  }, rating, timeZone)

  // Rough mastery bump: Again=-0.1, Hard=+0.02, Good=+0.08, Easy=+0.12. Clamped 0..1 by the RPC.
  const masteryDelta = rating === 1 ? -0.1 : rating === 2 ? 0.02 : rating === 3 ? 0.08 : 0.12

  const { error: rpcError } = await service.rpc('review_card_atomic', {
    p_card_id: cardId,
    p_user_id: user.id,
    p_fsrs_stability: next.fsrs_stability,
    p_fsrs_difficulty: next.fsrs_difficulty,
    p_fsrs_reps: next.fsrs_reps,
    p_fsrs_lapses: next.fsrs_lapses,
    p_fsrs_state: next.fsrs_state,
    p_fsrs_last_review: next.fsrs_last_review,
    p_fsrs_next_review_date: next.fsrs_next_review_date,
    p_mastery_delta: masteryDelta,
  })

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, nextDue: next.fsrs_next_review_date })
}
