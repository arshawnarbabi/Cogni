import { describe, it, expect } from 'vitest'
import { newCardDefaults, scheduleReview } from '@/lib/fsrs'
import { dateKeyInTimeZone, addDaysToDateKey } from '@/lib/time'

describe('newCardDefaults', () => {
  it('creates a fresh new-state card', () => {
    const c = newCardDefaults()
    expect(c.fsrs_state).toBe('new')
    expect(c.fsrs_reps).toBe(0)
    expect(c.fsrs_lapses).toBe(0)
    expect(c.fsrs_next_review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('scheduleReview clamp invariant', () => {
  const tz = 'America/Los_Angeles'

  it('a rated card never comes due again on the same local day', () => {
    // A new card rated "Good" schedules in minutes (still today) — must clamp forward.
    const next = scheduleReview(newCardDefaults(), 3, tz)
    const today = dateKeyInTimeZone(new Date(), tz)
    expect(next.fsrs_next_review_date > today).toBe(true)
    expect(next.fsrs_reps).toBe(1) // review was recorded
  })

  it('does NOT truncate a legitimate multi-day interval', () => {
    const today = dateKeyInTimeZone(new Date(), 'UTC')
    const mature = {
      fsrs_stability: 100,
      fsrs_difficulty: 5,
      fsrs_reps: 10,
      fsrs_lapses: 0,
      fsrs_state: 'review',
      fsrs_last_review: '2026-01-01T00:00:00.000Z',
      fsrs_next_review_date: today,
    }
    const next = scheduleReview(mature, 3, 'UTC')
    // A high-stability card reviewed "Good" should land well beyond tomorrow.
    expect(next.fsrs_next_review_date > addDaysToDateKey(today, 1)).toBe(true)
  })

  it('produces valid FSRS state fields', () => {
    const next = scheduleReview(newCardDefaults(), 4, tz)
    expect(['new', 'learning', 'review', 'relearning']).toContain(next.fsrs_state)
    expect(typeof next.fsrs_stability).toBe('number')
    expect(typeof next.fsrs_difficulty).toBe('number')
    expect(next.fsrs_next_review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
