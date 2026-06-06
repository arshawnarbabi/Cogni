import { describe, it, expect } from 'vitest'
import { computeGradeSummary, whatIfTargets, courseGradeStatus } from '@/lib/grades'

const SCHEME = [
  { category: 'Exams', weight_pct: 50 },
  { category: 'Homework', weight_pct: 30 },
  { category: 'Participation', weight_pct: 20 },
]

describe('computeGradeSummary (S1)', () => {
  it('weighted: averages within categories, weights across them', () => {
    const s = computeGradeSummary(SCHEME, [
      { category: 'Exams', points_earned: 80, points_possible: 100 },
      { category: 'Homework', points_earned: 9, points_possible: 10 },
      { category: 'Homework', points_earned: 7, points_possible: 10 },
    ])
    expect(s.mode).toBe('weighted')
    // Exams 80%, HW (9+7)/20 = 80% → over graded weight (50+30): (50*80 + 30*80)/80 = 80
    expect(s.current_pct).toBeCloseTo(80, 1)
    expect(s.graded_weight_pct).toBe(80)
    expect(s.by_category.find(c => c.category === 'Participation')!.earned_pct).toBeNull()
  })

  it('weighted: category matching is case/whitespace-insensitive', () => {
    const s = computeGradeSummary(SCHEME, [
      { category: '  exams ', points_earned: 90, points_possible: 100 },
    ])
    expect(s.by_category.find(c => c.category === 'Exams')!.earned_pct).toBe(90)
    expect(s.uncategorized_count).toBe(0)
  })

  it('points mode when no scheme exists', () => {
    const s = computeGradeSummary([], [
      { category: null, points_earned: 45, points_possible: 50 },
      { category: null, points_earned: 8, points_possible: 10 },
    ])
    expect(s.mode).toBe('points')
    expect(s.current_pct).toBeCloseTo((53 / 60) * 100, 1)
  })

  it('nothing graded → null current grade', () => {
    expect(computeGradeSummary(SCHEME, []).current_pct).toBeNull()
    expect(computeGradeSummary([], [{ category: null, points_earned: null, points_possible: 100 }]).current_pct).toBeNull()
  })

  it('ungraded items (null earned) are excluded from the average', () => {
    const s = computeGradeSummary(SCHEME, [
      { category: 'Exams', points_earned: 80, points_possible: 100 },
      { category: 'Exams', points_earned: null, points_possible: 100 },
    ])
    expect(s.by_category.find(c => c.category === 'Exams')!.earned_pct).toBe(80)
  })
})

describe('whatIfTargets — "what do I need on the final?" (S1)', () => {
  it('computes the needed % on remaining weight', () => {
    // Graded: Exams 80% (50w), HW 80% (30w) → locked in 0.5*80 + 0.3*80 = 64 grade points.
    // Remaining: Participation 20w. Target 90: need (90-64)/20*100 = 130% → not achievable.
    // Target 80: (80-64)/20*100 = 80%. Target 70: (70-64)/20*100 = 30%.
    const items = [
      { category: 'Exams', points_earned: 80, points_possible: 100 },
      { category: 'Homework', points_earned: 16, points_possible: 20 },
    ]
    const [a, b, c] = whatIfTargets(SCHEME, items, [90, 80, 70])
    expect(a.needed_pct).toBe(130)
    expect(a.achievable).toBe(false)
    expect(b.needed_pct).toBe(80)
    expect(b.achievable).toBe(true)
    expect(c.needed_pct).toBe(30)
    expect(c.already_secured).toBe(false)
  })

  it('already secured: even 0 on the rest still clears the target', () => {
    const items = [
      { category: 'Exams', points_earned: 100, points_possible: 100 },
      { category: 'Homework', points_earned: 30, points_possible: 30 },
    ]
    // Locked: 0.5*100 + 0.3*100 = 80 grade points; target 70 cleared with 0 on the rest.
    const [t] = whatIfTargets(SCHEME, items, [70])
    expect(t.already_secured).toBe(true)
    expect(t.needed_pct).toBe(0)
  })

  it('fully graded course: needed is null, achievable reflects the final grade', () => {
    const items = [
      { category: 'Exams', points_earned: 90, points_possible: 100 },
      { category: 'Homework', points_earned: 27, points_possible: 30 },
      { category: 'Participation', points_earned: 20, points_possible: 20 },
    ]
    const [pass, ace] = whatIfTargets(SCHEME, items, [80, 95])
    expect(pass.needed_pct).toBeNull()
    expect(pass.achievable).toBe(true)
    expect(ace.achievable).toBe(false)
  })

  it('points mode: remaining = recorded-but-ungraded items', () => {
    const items = [
      { category: null, points_earned: 80, points_possible: 100 },
      { category: null, points_earned: null, points_possible: 100 }, // the final, recorded ungraded
    ]
    // total 200: locked 80/200 = 40 grade points; remaining weight 50.
    // Target 80: need (80-40)/50*100 = 80%.
    const [t] = whatIfTargets([], items, [80])
    expect(t.needed_pct).toBe(80)
    expect(t.achievable).toBe(true)
  })

  it('no items at all in points mode → null needed, not a crash', () => {
    const [t] = whatIfTargets([], [], [80])
    expect(t.needed_pct).toBeNull()
    expect(t.achievable).toBe(false)
  })
})

describe('courseGradeStatus — the at-risk signal (S1 integration)', () => {
  it('healthy course: not at risk', () => {
    const s = courseGradeStatus(SCHEME, [
      { category: 'Exams', points_earned: 90, points_possible: 100 },
      { category: 'Homework', points_earned: 28, points_possible: 30 },
    ])
    expect(s).not.toBeNull()
    expect(s!.at_risk).toBe(false)
  })

  it('low current grade (<75) is at risk', () => {
    const s = courseGradeStatus(SCHEME, [
      { category: 'Exams', points_earned: 65, points_possible: 100 },
    ])
    expect(s!.current_pct).toBe(65)
    expect(s!.at_risk).toBe(true)
  })

  it('needing ≥85% on the rest for a B- is at risk even with a decent current grade', () => {
    // Exams 76% on 50w → locked 38; B- needs (80-38)/50*100 = 84%... tune: 75% → locked 37.5, need 85%.
    const s = courseGradeStatus(SCHEME, [
      { category: 'Exams', points_earned: 75, points_possible: 100 },
    ])
    expect(s!.current_pct).toBe(75)
    expect(s!.needed_for_b).toBe(85)
    expect(s!.at_risk).toBe(true)
  })

  it('B- out of reach is at risk', () => {
    const s = courseGradeStatus(SCHEME, [
      { category: 'Exams', points_earned: 40, points_possible: 100 },
      { category: 'Homework', points_earned: 10, points_possible: 30 },
    ])
    expect(s!.b_reachable).toBe(false)
    expect(s!.at_risk).toBe(true)
  })

  it('no grades yet: null (no alarm on fresh courses)', () => {
    expect(courseGradeStatus(SCHEME, [])).toBeNull()
  })
})
