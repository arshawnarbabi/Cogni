import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs'
import { dateKeyInTimeZone, addDaysToDateKey } from '@/lib/time'

export { Rating }

// Long-term-only scheduler: Cogni is one-session-per-day (dues are clamped to
// tomorrow), so the default short-term learning steps ('1m','10m') can never be
// honored — and because learning_steps was never persisted, a card rated Good
// restarted step 0 every day and stayed in 'learning' FOREVER (intervals never
// grew, the queue bloated). enable_short_term:false graduates cards straight to
// 'review' with real day-scale intervals, which is the behavior the app assumes.
const f = fsrs({ enable_short_term: false })

export function newCardDefaults() {
  const card = createEmptyCard()
  return dbFromCard(card)
}

export function scheduleReview(
  dbCard: {
    fsrs_stability: number
    fsrs_difficulty: number
    fsrs_reps: number
    fsrs_lapses: number
    fsrs_state: string
    fsrs_last_review: string | null
    fsrs_next_review_date: string
  },
  rating: 1 | 2 | 3 | 4,
  timeZone = 'UTC'
) {
  const stateMap: Record<string, number> = { new: 0, learning: 1, review: 2, relearning: 3 }
  const card: Card = {
    due: new Date(dbCard.fsrs_next_review_date),
    stability: dbCard.fsrs_stability,
    difficulty: dbCard.fsrs_difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: dbCard.fsrs_reps,
    lapses: dbCard.fsrs_lapses,
    learning_steps: 0,
    state: stateMap[dbCard.fsrs_state] ?? 0,
    last_review: dbCard.fsrs_last_review ? new Date(dbCard.fsrs_last_review) : undefined,
  }

  const now = new Date()
  const scheduling = f.repeat(card, now)
  // scheduling keys are '1'|'2'|'3'|'4' matching Rating enum values
  const next = (scheduling as unknown as Record<string, { card: Card }>)[String(rating)].card

  return dbFromCard(next, { clampToTomorrow: true, timeZone })
}

/**
 * Current FSRS retrievability (probability of recall, 0..1) for a stored card.
 * I4: the review queue front-loads the cards MOST at risk of being forgotten —
 * raw due-date order treats a card 1 day overdue the same as one 3 weeks
 * overdue. New/never-reviewed cards return 0 (must be (re)learned).
 */
export function cardRetrievability(dbCard: {
  fsrs_stability: number | null
  fsrs_difficulty: number | null
  fsrs_reps: number
  fsrs_lapses: number
  fsrs_state: string
  fsrs_last_review: string | null
  fsrs_next_review_date: string
}): number {
  if (!dbCard.fsrs_last_review || dbCard.fsrs_state === 'new') return 0
  const stateMap: Record<string, number> = { new: 0, learning: 1, review: 2, relearning: 3 }
  const card: Card = {
    due: new Date(dbCard.fsrs_next_review_date),
    stability: Number(dbCard.fsrs_stability ?? 0),
    difficulty: Number(dbCard.fsrs_difficulty ?? 5),
    elapsed_days: 0,
    scheduled_days: 0,
    reps: dbCard.fsrs_reps,
    lapses: dbCard.fsrs_lapses,
    learning_steps: 0,
    state: stateMap[dbCard.fsrs_state] ?? 0,
    last_review: new Date(dbCard.fsrs_last_review),
  }
  try {
    const r = f.get_retrievability(card, new Date(), false)
    return typeof r === 'number' && Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0
  } catch {
    return 0
  }
}

function dbFromCard(card: Card, opts: { clampToTomorrow?: boolean; timeZone?: string } = {}) {
  const stateLabel = ['new', 'learning', 'review', 'relearning'][card.state] ?? 'new'
  // fsrs_next_review_date is a date column, but ts-fsrs schedules learning-phase
  // cards in minutes (e.g. "Good" on a new card → +10 min, still today). Without
  // clamping, the card would round to today and reappear in the same session.
  // Cogni is one-session-per-day, so once rated the card moves to tomorrow at soonest.
  // Use the user's local date (the same dateKeyInTimeZone the .lte('fsrs_next_review_date', today)
  // due queries use) so the clamp boundary matches the local "today" and a reviewed card
  // can't reappear in the same local session.
  const tz = opts.timeZone ?? 'UTC'
  const todayStr = dateKeyInTimeZone(new Date(), tz)
  let dueStr = dateKeyInTimeZone(card.due, tz)
  if (opts.clampToTomorrow && dueStr <= todayStr) {
    dueStr = addDaysToDateKey(todayStr, 1)
  }
  return {
    fsrs_stability: card.stability,
    fsrs_difficulty: card.difficulty,
    fsrs_last_review: card.last_review?.toISOString() ?? null,
    fsrs_next_review_date: dueStr,
    fsrs_reps: card.reps,
    fsrs_lapses: card.lapses,
    fsrs_state: stateLabel,
  }
}
