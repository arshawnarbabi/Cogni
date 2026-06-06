import { createClient, createServiceClient } from '@/lib/supabase/server'
import { scheduleReview } from '@/lib/fsrs'
import { flashcardEvidence } from '@/lib/mastery'
import { NextResponse } from 'next/server'
import { serverError } from '@/lib/api-error'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const { cardId, rating, clientReviewId } = await request.json() as {
    cardId: string
    rating: 1 | 2 | 3 | 4
    clientReviewId?: string
  }

  if (!cardId || ![1, 2, 3, 4].includes(rating)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // Idempotency key (B6): the client generates one uuid per rating tap; a
  // retried/replayed POST carries the same id and the RPC applies it exactly
  // once. Absent/malformed → null (legacy behavior, no dedup).
  const reviewId = typeof clientReviewId === 'string' && UUID_RE.test(clientReviewId) ? clientReviewId : null

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

  // Unified mastery evidence (F3): the rating maps to an observed level and a
  // learning rate scaled by 1/sqrt(cards in this topic), applied as an EWMA
  // inside the RPC — replacing the old flat additive delta that drifted with
  // review volume and disagreed with the tutor/quiz scales (B4).
  let cardsInTopic = 1
  if (card.topic_id) {
    const { count } = await service
      .from('flashcards')
      .select('card_id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('topic_id', card.topic_id)
    cardsInTopic = count ?? 1
  }
  const { observed, learningRate } = flashcardEvidence(rating, cardsInTopic)

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
    p_observed: observed,
    p_learning_rate: learningRate,
    p_rating: rating,
    p_client_review_id: reviewId,
  })

  if (rpcError) {
    return serverError('cards/review', rpcError)
  }

  return NextResponse.json({ ok: true, nextDue: next.fsrs_next_review_date })
}
