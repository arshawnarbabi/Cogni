import { describe, it, expect } from 'vitest'
import { nextMastery, flashcardEvidence, resolveTopicByName, effectiveMastery, carryoverSeed, LEARNING_RATES, DECAY_HALF_LIFE_DAYS, DECAY_GRACE_DAYS, CARRYOVER_FACTOR } from '@/lib/mastery'

describe('nextMastery (unified update rule)', () => {
  it('moves toward the observed level by the learning rate', () => {
    // old=0.5, observed=0.9, lr=0.6 → 0.5 + 0.6*(0.4) = 0.74
    const r = nextMastery(0.5, 0.2, 0.9, 0.6, true)
    expect(r.score).toBeCloseTo(0.74, 2)
  })

  it('is identical to the legacy quiz blend old*(1-w) + new*w', () => {
    const old = 0.3
    const observed = 0.8
    const w = 0.6
    const legacy = old * (1 - w) + observed * w
    expect(nextMastery(old, 0, observed, w, true).score).toBeCloseTo(legacy, 2)
  })

  it('one tutor grade no longer nukes a high mastery to zero (B4)', () => {
    const r = nextMastery(0.8, 0.5, 0, LEARNING_RATES.tutor_grade, true)
    expect(r.score).toBeGreaterThan(0.4) // was 0 under the absolute-set behavior
    expect(r.score).toBeLessThan(0.8)
  })

  it('one perfect answer no longer maxes a low mastery to 1.0 (B4)', () => {
    const r = nextMastery(0.2, 0.1, 1.0, LEARNING_RATES.tutor_grade, true)
    expect(r.score).toBeLessThan(0.6) // was 1.0 under the absolute-set behavior
    expect(r.score).toBeGreaterThan(0.2)
  })

  it('adopts the observed level directly when there is no prior row', () => {
    const r = nextMastery(0, 0, 0.85, 0.6, false)
    expect(r.score).toBeCloseTo(0.85, 2)
  })

  it('clamps observed and score into [0, 1]', () => {
    expect(nextMastery(0.9, 0, 5, 1, true).score).toBeLessThanOrEqual(1)
    expect(nextMastery(0.1, 0, -3, 1, true).score).toBeGreaterThanOrEqual(0)
  })

  it('grows confidence with each evidence event, capped at 1', () => {
    expect(nextMastery(0.5, 0, 0.5, 0.5, true).confidence).toBeCloseTo(0.05, 2)
    expect(nextMastery(0.5, 0.98, 0.5, 0.5, true).confidence).toBe(1)
  })
})

describe('flashcardEvidence', () => {
  it('maps ratings to observed levels (Again=0 … Easy=1)', () => {
    expect(flashcardEvidence(1, 1).observed).toBe(0)
    expect(flashcardEvidence(4, 1).observed).toBe(1)
    expect(flashcardEvidence(2, 1).observed).toBeLessThan(flashcardEvidence(3, 1).observed)
  })

  it('scales the learning rate by 1/sqrt(cards in topic)', () => {
    const small = flashcardEvidence(3, 4).learningRate  // base/2
    const large = flashcardEvidence(3, 100).learningRate // base/10
    expect(small).toBeCloseTo(LEARNING_RATES.flashcard_base / 2, 3)
    expect(large).toBeCloseTo(LEARNING_RATES.flashcard_base / 10, 3)
    expect(small).toBeGreaterThan(large)
  })

  it('handles a zero/one card topic without dividing by zero', () => {
    expect(flashcardEvidence(3, 0).learningRate).toBeCloseTo(LEARNING_RATES.flashcard_base, 3)
  })

  it('a Good on a 50-card topic moves mastery far less than on a 3-card topic', () => {
    const big = flashcardEvidence(3, 50)
    const small = flashcardEvidence(3, 3)
    const fromBig = nextMastery(0.5, 0, big.observed, big.learningRate, true).score - 0.5
    const fromSmall = nextMastery(0.5, 0, small.observed, small.learningRate, true).score - 0.5
    expect(fromSmall).toBeGreaterThan(fromBig * 2)
  })
})

describe('effectiveMastery (time decay, I1)', () => {
  const DAY = 86_400_000
  const now = 1_750_000_000_000

  it('no decay within the grace week', () => {
    expect(effectiveMastery(0.8, new Date(now - 3 * DAY), now)).toBeCloseTo(0.8, 2)
    expect(effectiveMastery(0.8, new Date(now - DECAY_GRACE_DAYS * DAY), now)).toBeCloseTo(0.8, 2)
  })

  it('halves after one half-life past the grace week', () => {
    const t = new Date(now - (DECAY_GRACE_DAYS + DECAY_HALF_LIFE_DAYS) * DAY)
    expect(effectiveMastery(0.8, t, now)).toBeCloseTo(0.4, 2)
  })

  it('a week-2 cram no longer shows full mastery in week 10 (the I1 scenario)', () => {
    const eightWeeksAgo = new Date(now - 56 * DAY)
    const eff = effectiveMastery(0.85, eightWeeksAgo, now)
    expect(eff).toBeLessThan(0.55)
    expect(eff).toBeGreaterThan(0.2) // decays, doesn't vanish
  })

  it('handles zero/null score and missing/garbage timestamps', () => {
    expect(effectiveMastery(0, new Date(now - 100 * DAY), now)).toBe(0)
    expect(effectiveMastery(null, null, now)).toBe(0)
    expect(effectiveMastery(0.6, null, now)).toBeCloseTo(0.6, 2)
    expect(effectiveMastery(0.6, 'not-a-date', now)).toBeCloseTo(0.6, 2)
  })
})

describe('resolveTopicByName', () => {
  const topics = [
    { topic_id: 'a', name: 'Limits and Continuity' },
    { topic_id: 'b', name: 'The Chain Rule' },
    { topic_id: 'c', name: 'Integration by Parts' },
  ]

  it('exact case-insensitive match wins', () => {
    expect(resolveTopicByName('the chain rule', topics)).toBe('b')
  })

  it('falls back to longest containment match', () => {
    expect(resolveTopicByName('Chain Rule', topics)).toBe('b')
    expect(resolveTopicByName('Integration', topics)).toBe('c')
  })

  it('returns null rather than guessing on no match', () => {
    expect(resolveTopicByName('Thermodynamics', topics)).toBeNull()
    expect(resolveTopicByName('', topics)).toBeNull()
  })
})

describe('carryoverSeed (cross-course mastery carryover, S9)', () => {
  const prior = [
    { name: 'Limits and Continuity', eff: 0.8 },
    { name: 'The Chain Rule', eff: 0.6 },
    { name: 'Weak Topic', eff: 0.1 },
  ]

  it('exact match carries a discounted fraction of the prior', () => {
    expect(carryoverSeed('limits and continuity', prior)).toBeCloseTo(0.8 * CARRYOVER_FACTOR, 2)
  })

  it('containment match works for meaningful names', () => {
    expect(carryoverSeed('Chain Rule', prior)).toBeCloseTo(0.6 * CARRYOVER_FACTOR, 2)
  })

  it('does not carry weak priors (noise floor)', () => {
    expect(carryoverSeed('Weak Topic', prior)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(carryoverSeed('Thermodynamics', prior)).toBeNull()
    expect(carryoverSeed('', prior)).toBeNull()
  })

  it('short names never containment-match (no "and" over-matching)', () => {
    expect(carryoverSeed('Rule', [{ name: 'The Chain Rule', eff: 0.9 }])).toBeNull()
  })
})
