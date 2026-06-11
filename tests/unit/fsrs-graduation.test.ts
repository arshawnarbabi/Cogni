import { describe, it, expect } from 'vitest'
import { newCardDefaults, scheduleReview } from '@/lib/fsrs'

// A2 audit fix: with the default short-term scheduler + learning_steps never
// persisted, a card rated Good restarted learning step 0 every day and stayed
// in 'learning' FOREVER (intervals never grew). The long-term scheduler
// (enable_short_term: false) graduates on the first real rating.
describe('FSRS — cards graduate and intervals grow (long-term scheduler)', () => {
  it('a new card rated Good graduates to review with a day-scale interval', () => {
    const fresh = { ...newCardDefaults(), fsrs_next_review_date: '2026-06-10' }
    const after = scheduleReview(fresh as Parameters<typeof scheduleReview>[0], 3)
    expect(after.fsrs_state).toBe('review')
    expect(after.fsrs_next_review_date > new Date().toISOString().slice(0, 10)).toBe(true)
  })

  it('re-reviewing a graduated card keeps it in review (never restarts learning)', () => {
    // (Both reviews run at the same instant here, so stability can't grow —
    // what this locks in is that a Good on a review-state card stays 'review'
    // with positive stability, instead of the old forever-learning loop.)
    let card = { ...newCardDefaults(), fsrs_next_review_date: '2026-06-10' }
    card = { ...card, ...scheduleReview(card as Parameters<typeof scheduleReview>[0], 3) }
    card = { ...card, ...scheduleReview(card as Parameters<typeof scheduleReview>[0], 3) }
    expect(card.fsrs_state).toBe('review')
    expect(card.fsrs_reps).toBe(2)
    expect(card.fsrs_stability).toBeGreaterThan(0)
  })

  it('Again on a review card lapses it without resetting to permanent learning', () => {
    let card = { ...newCardDefaults(), fsrs_next_review_date: '2026-06-10' }
    card = { ...card, ...scheduleReview(card as Parameters<typeof scheduleReview>[0], 3) }
    const lapsed = scheduleReview(card as Parameters<typeof scheduleReview>[0], 1)
    expect(lapsed.fsrs_lapses).toBe(1)
    // long-term scheduler keeps the card in 'review' (no relearning limbo)
    const recovered = scheduleReview({ ...card, ...lapsed } as Parameters<typeof scheduleReview>[0], 3)
    expect(recovered.fsrs_state).toBe('review')
  })
})
