import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs'
import { dateKeyInTimeZone, addDaysToDateKey } from '@/lib/time'

export { Rating }

const f = fsrs()

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
