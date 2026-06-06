// ─────────────────────────────────────────────────────────────────────────────
// Grade math (S1) — pure functions, unit-tested. Answers the two questions
// students actually have: "what's my grade right now?" and "what do I need on
// the rest to hit my target?"
//
// Two modes:
//  - WEIGHTED: the course has a grading scheme (category → % of final grade).
//    Current grade = weighted average of each graded category's earned %,
//    normalized over the weight that has any grades yet.
//  - POINTS: no scheme — plain points earned / points possible.
// ─────────────────────────────────────────────────────────────────────────────

export type SchemeCategory = {
  category: string
  weight_pct: number
}

export type GradeItemInput = {
  category: string | null
  points_earned: number | null // null = recorded but not graded yet
  points_possible: number
}

export type CategorySummary = {
  category: string
  weight_pct: number
  earned_pct: number | null // null = nothing graded in this category yet
  graded_count: number
}

export type GradeSummary = {
  mode: 'weighted' | 'points'
  /** Current grade 0–100 over what's been graded so far (null = nothing graded). */
  current_pct: number | null
  /** Of the total scheme weight, how much has at least one graded item. */
  graded_weight_pct: number
  by_category: CategorySummary[]
  uncategorized_count: number
}

const round1 = (n: number) => Math.round(n * 10) / 10

function norm(s: string): string {
  return s.trim().toLowerCase()
}

export function computeGradeSummary(
  scheme: SchemeCategory[],
  items: GradeItemInput[],
): GradeSummary {
  const graded = items.filter(i => i.points_earned !== null && i.points_possible > 0)

  if (scheme.length === 0) {
    // POINTS mode
    const possible = graded.reduce((s, i) => s + i.points_possible, 0)
    const earned = graded.reduce((s, i) => s + (i.points_earned as number), 0)
    return {
      mode: 'points',
      current_pct: possible > 0 ? round1((earned / possible) * 100) : null,
      graded_weight_pct: possible > 0 ? 100 : 0,
      by_category: [],
      uncategorized_count: items.length,
    }
  }

  const byCategory: CategorySummary[] = scheme.map(c => {
    const inCat = graded.filter(i => i.category !== null && norm(i.category) === norm(c.category))
    const possible = inCat.reduce((s, i) => s + i.points_possible, 0)
    const earned = inCat.reduce((s, i) => s + (i.points_earned as number), 0)
    return {
      category: c.category,
      weight_pct: c.weight_pct,
      earned_pct: possible > 0 ? round1((earned / possible) * 100) : null,
      graded_count: inCat.length,
    }
  })

  const gradedCats = byCategory.filter(c => c.earned_pct !== null)
  const gradedWeight = gradedCats.reduce((s, c) => s + c.weight_pct, 0)
  const weightedSum = gradedCats.reduce((s, c) => s + c.weight_pct * (c.earned_pct as number), 0)

  const schemeCategories = new Set(scheme.map(c => norm(c.category)))
  const uncategorized = items.filter(i => i.category === null || !schemeCategories.has(norm(i.category))).length

  return {
    mode: 'weighted',
    current_pct: gradedWeight > 0 ? round1(weightedSum / gradedWeight) : null,
    graded_weight_pct: round1(gradedWeight),
    by_category: byCategory,
    uncategorized_count: uncategorized,
  }
}

export type WhatIf = {
  target_pct: number
  /** % needed on ALL remaining (ungraded) weight to land exactly on target.
   *  null = no remaining weight to earn (course fully graded). */
  needed_pct: number | null
  achievable: boolean // needed ≤ 100
  already_secured: boolean // even 0 on the rest still hits the target
}

/**
 * "What do I need on the rest?" Final grade = Σ_graded wᵢ·eᵢ/100 + remaining·x/100,
 * solve for x. POINTS mode has no notion of "remaining" (unknown future items),
 * so it returns null needed unless ungraded items are recorded.
 */
export function whatIfTargets(
  scheme: SchemeCategory[],
  items: GradeItemInput[],
  targets: number[] = [90, 80, 70],
): WhatIf[] {
  const summary = computeGradeSummary(scheme, items)

  let gradedContribution: number // grade points already locked in (0–100 scale)
  let remainingWeight: number    // weight still to be earned

  if (summary.mode === 'weighted') {
    const gradedCats = summary.by_category.filter(c => c.earned_pct !== null)
    gradedContribution = gradedCats.reduce((s, c) => s + (c.weight_pct * (c.earned_pct as number)) / 100, 0)
    const totalWeight = scheme.reduce((s, c) => s + c.weight_pct, 0)
    remainingWeight = Math.max(0, totalWeight - summary.graded_weight_pct)
  } else {
    // POINTS mode: remaining = recorded-but-ungraded items only.
    const graded = items.filter(i => i.points_earned !== null)
    const ungraded = items.filter(i => i.points_earned === null)
    const gradedPossible = graded.reduce((s, i) => s + i.points_possible, 0)
    const ungradedPossible = ungraded.reduce((s, i) => s + i.points_possible, 0)
    const total = gradedPossible + ungradedPossible
    if (total === 0) {
      return targets.map(t => ({ target_pct: t, needed_pct: null, achievable: false, already_secured: false }))
    }
    const earned = graded.reduce((s, i) => s + (i.points_earned as number), 0)
    gradedContribution = (earned / total) * 100
    remainingWeight = (ungradedPossible / total) * 100
  }

  return targets.map(target => {
    if (remainingWeight <= 0) {
      const final = round1(gradedContribution)
      return {
        target_pct: target,
        needed_pct: null,
        achievable: final >= target,
        already_secured: final >= target,
      }
    }
    const needed = ((target - gradedContribution) / remainingWeight) * 100
    return {
      target_pct: target,
      needed_pct: round1(Math.max(0, needed)),
      achievable: needed <= 100,
      already_secured: needed <= 0,
    }
  })
}
