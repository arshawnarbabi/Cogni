import { createServiceClient } from '@/lib/supabase/server'

// ─────────────────────────────────────────────────────────────────────────────
// Unified mastery service (F3) — the ONE place mastery math lives.
//
// Previously three writers fought over topic_mastery.mastery_score on three
// incompatible scales (verified bug B4):
//   - tutor grade_answer  → ABSOLUTE set (one question nuked/maxed the topic)
//   - practice quiz       → exponential blend old*(1-w) + new*w
//   - flashcard review    → flat additive delta (-0.1/+0.02/+0.08/+0.12)
// The displayed score depended on the ORDER you studied in. Every writer now
// expresses its signal as evidence: { observed level 0..1, learning rate } and
// the same update rule applies everywhere:
//
//     next = old + learningRate * (observed - old)        (EWMA toward observed)
//
// learningRate encodes how much one piece of evidence should move the estimate:
//   - a graded quiz over several questions is strong (0.6 standalone / 0.3 in-session
//     — IDENTICAL math to the old quiz blend, so quiz behavior is preserved)
//   - a single tutor verification question is moderate (0.35 — no longer absolute)
//   - one flashcard flip is weak, and scaled by 1/sqrt(cards in the topic) so one
//     "Good" on a 50-card topic moves the topic far less than on a 3-card topic
//
// confidence (previously a dead column, always 0) now grows with each piece of
// evidence — downstream consumers can distinguish "50% after 40 reviews" from
// "50% after one quiz".
//
// The flashcard path applies this rule INSIDE the review_card_atomic RPC (it must
// stay transactional with the FSRS write); the RPC receives (observed, learningRate)
// computed by flashcardEvidence() below, so the policy still lives here.
// ─────────────────────────────────────────────────────────────────────────────

export const LEARNING_RATES = {
  tutor_grade: 0.35,
  quiz_standalone: 0.6,
  quiz_in_session: 0.3,
  exam: 0.7,
  flashcard_base: 0.25,
  conversation: 0.12, // distilled tutoring-session signals (I2) — weak evidence
} as const

// What a flashcard rating says about the student's level on the topic.
const OBSERVED_BY_RATING: Record<1 | 2 | 3 | 4, number> = {
  1: 0,    // Again — didn't know it
  2: 0.45, // Hard — knew it shakily
  3: 0.75, // Good
  4: 1.0,  // Easy
}

/** Observed level for one flashcard rating. The 1/sqrt(deck) learning-rate
 *  scaling happens INSIDE review_card_atomic (the deck count runs under the
 *  row lock the RPC already holds — no extra round trip per rating tap);
 *  the policy values still live here. */
export function flashcardObserved(rating: 1 | 2 | 3 | 4): number {
  return OBSERVED_BY_RATING[rating]
}

const CONFIDENCE_STEP = 0.05

export type MasteryUpdate = {
  score: number
  confidence: number
}

// The shared update rule. Pure — unit-tested directly.
// hasPrior=false (no topic_mastery row at all) → the prior is uninformative, so
// adopt the observed level directly instead of blending against a phantom zero.
// (Profiler-seeded topics have a real score-0 row, so they DO blend from 0 —
// matching the previous quiz behavior exactly.)
export function nextMastery(
  oldScore: number,
  oldConfidence: number,
  observed: number,
  learningRate: number,
  hasPrior: boolean,
): MasteryUpdate {
  const clampedObserved = Math.min(1, Math.max(0, observed))
  const lr = Math.min(1, Math.max(0, learningRate))
  const score = hasPrior
    ? Math.min(1, Math.max(0, oldScore + lr * (clampedObserved - oldScore)))
    : clampedObserved
  const confidence = Math.min(1, Math.max(0, oldConfidence) + CONFIDENCE_STEP)
  return { score: round2(score), confidence: round2(confidence) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Time decay (I1) ──────────────────────────────────────────────────────────
// A score earned weeks ago and never revisited is NOT current knowledge — an
// exam tests what you know NOW. Mastery previously only changed on review, so a
// topic crammed in week 2 showed 85% forever and the scheduler stopped
// surfacing it. Effective mastery decays exponentially after a grace week:
// half-life 60 days. Applied lazily at READ time (no cron, stored score
// untouched — new evidence through nextMastery() naturally "resets" it).
export const DECAY_GRACE_DAYS = 7
export const DECAY_HALF_LIFE_DAYS = 60

export function effectiveMastery(
  score: number | null | undefined,
  lastUpdated: string | Date | null | undefined,
  now: number = Date.now(),
): number {
  const s = Number(score ?? 0)
  if (s <= 0) return 0
  if (!lastUpdated) return round2(s)
  const updatedMs = new Date(lastUpdated).getTime()
  if (!Number.isFinite(updatedMs)) return round2(s)
  const days = (now - updatedMs) / 86_400_000
  if (days <= DECAY_GRACE_DAYS) return round2(s)
  return round2(s * Math.exp(-Math.LN2 * (days - DECAY_GRACE_DAYS) / DECAY_HALF_LIFE_DAYS))
}

// Evidence parameters for one flashcard rating. The per-flip learning rate is
// scaled by 1/sqrt(cards in topic): a topic's mastery should reflect the deck,
// not drift unboundedly with review volume.
// NOTE: in production this scaling runs INSIDE review_card_atomic (the deck
// count happens under the RPC's row lock); this function is the unit-tested
// reference implementation of the same policy — keep them in sync.
export function flashcardEvidence(
  rating: 1 | 2 | 3 | 4,
  cardsInTopic: number,
): { observed: number; learningRate: number } {
  const observed = OBSERVED_BY_RATING[rating]
  const learningRate = LEARNING_RATES.flashcard_base / Math.sqrt(Math.max(1, cardsInTopic))
  return { observed, learningRate: round4(learningRate) }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// Course-scoped topic resolution shared by the tutor and quiz paths. Exact
// (case-insensitive) match wins; falls back to the longest containment match,
// deterministically. Returns null rather than guessing wildly — callers must
// treat a miss as "no mastery signal", never write to an unrelated topic.
export function resolveTopicByName(
  topicName: string,
  courseTopics: { topic_id: string; name: string }[],
): string | null {
  const needle = topicName.trim().toLowerCase()
  if (!needle) return null

  for (const t of courseTopics) {
    if (t.name.toLowerCase() === needle) return t.topic_id
  }

  let bestName = ''
  let bestId: string | null = null
  for (const t of courseTopics) {
    const name = t.name.toLowerCase()
    if (name.includes(needle) || needle.includes(name)) {
      if (name.length > bestName.length) {
        bestName = name
        bestId = t.topic_id
      }
    }
  }
  return bestId
}

// ── Cross-course mastery carryover (S9) ──────────────────────────────────────
// A student who finished Calc I doesn't start Calc II's "Limits Review" at
// zero. When the profiler creates a topic whose name matches one the student
// already built mastery on in ANOTHER course, the new topic seeds at a
// discounted fraction of the (time-decayed) prior — knowledge transfers, but
// context changes, so it carries conservatively.
export const CARRYOVER_FACTOR = 0.6
export const CARRYOVER_MIN_PRIOR = 0.25 // don't carry noise

export type PriorTopic = { name: string; eff: number }

/** Seed mastery for a new topic from prior-course topics, or null if nothing
 *  carries. Exact (case-insensitive) name match first, then containment —
 *  the SAME contract as resolveTopicByName. */
export function carryoverSeed(newTopicName: string, priorTopics: PriorTopic[]): number | null {
  const needle = newTopicName.trim().toLowerCase()
  if (!needle) return null

  let best: PriorTopic | null = null
  for (const p of priorTopics) {
    if (p.name.toLowerCase() === needle) {
      best = p
      break
    }
  }
  if (!best) {
    let bestLen = 0
    for (const p of priorTopics) {
      const name = p.name.toLowerCase()
      // Containment only counts for meaningful names — single words like "and"
      // would over-match.
      if (name.length >= 6 && needle.length >= 6 && (name.includes(needle) || needle.includes(name))) {
        if (name.length > bestLen) {
          bestLen = name.length
          best = p
        }
      }
    }
  }

  if (!best || best.eff < CARRYOVER_MIN_PRIOR) return null
  return round2(best.eff * CARRYOVER_FACTOR)
}

export type EvidenceInput = {
  topicId: string
  observed: number
  learningRate: number
}

export type AppliedEvidence = {
  topicId: string
  oldScore: number
  newScore: number
  confidence: number
}

// Apply evidence for one or many topics in three round trips total (select,
// upsert, history insert) — the same batching the quiz path already used.
export async function applyMasteryEvidence(
  userId: string,
  evidences: EvidenceInput[],
): Promise<AppliedEvidence[]> {
  if (evidences.length === 0) return []
  const service = createServiceClient()

  const topicIds = evidences.map(e => e.topicId)
  const { data: existingRows, error: selectError } = await service
    .from('topic_mastery')
    .select('topic_id, mastery_score, confidence')
    .eq('user_id', userId)
    .in('topic_id', topicIds)
  // A failed prior-read must ABORT: treating it as "no prior" would adopt the
  // raw observation and silently clobber accumulated mastery (one wrong tutor
  // answer would overwrite a 0.9 with ~0). Fatal like the upsert error below.
  if (selectError) {
    console.error('[mastery] prior select failed', selectError)
    throw new Error('mastery prior select failed')
  }

  const existing = new Map<string, { score: number; confidence: number }>()
  for (const row of (existingRows ?? []) as { topic_id: string; mastery_score: number | null; confidence: number | null }[]) {
    existing.set(row.topic_id, { score: Number(row.mastery_score ?? 0), confidence: Number(row.confidence ?? 0) })
  }

  const nowIso = new Date().toISOString()
  const applied: AppliedEvidence[] = []
  const upserts: { user_id: string; topic_id: string; mastery_score: number; confidence: number; last_updated: string }[] = []
  const history: { user_id: string; topic_id: string; mastery_score: number }[] = []

  // Group by topic and FOLD multiple observations for the same topic through the
  // EWMA sequentially. Critical: a single upsert cannot touch the same
  // (user_id, topic_id) twice — Postgres rejects "ON CONFLICT DO UPDATE command
  // cannot affect row a second time" and the whole write fails. This happens
  // routinely when a quiz's questions carry different sub-topic labels that all
  // resolve to one tracked topic, so quiz mastery would silently never move.
  const byTopic = new Map<string, EvidenceInput[]>()
  for (const e of evidences) {
    const arr = byTopic.get(e.topicId) ?? []
    arr.push(e)
    byTopic.set(e.topicId, arr)
  }

  for (const [topicId, group] of byTopic) {
    const prior = existing.get(topicId)
    const oldScore = prior?.score ?? 0
    let score = oldScore
    let confidence = prior?.confidence ?? 0
    let hasPrior = !!prior
    for (const e of group) {
      const next = nextMastery(score, confidence, e.observed, e.learningRate, hasPrior)
      score = next.score
      confidence = next.confidence
      hasPrior = true // after the first observation, subsequent ones blend
    }
    applied.push({ topicId, oldScore, newScore: score, confidence })
    upserts.push({ user_id: userId, topic_id: topicId, mastery_score: score, confidence, last_updated: nowIso })
    history.push({ user_id: userId, topic_id: topicId, mastery_score: score })
  }

  const { error: masteryError } = await service
    .from('topic_mastery')
    .upsert(upserts, { onConflict: 'user_id,topic_id' })
  if (masteryError) {
    console.error('[mastery] upsert failed', masteryError)
    throw new Error('mastery upsert failed')
  }

  // History rows only after a successful mastery write.
  const { error: historyError } = await service.from('mastery_history').insert(history)
  if (historyError) console.error('[mastery] history insert failed', historyError)

  return applied
}
