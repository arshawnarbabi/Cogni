import { createServiceClient } from '@/lib/supabase/server'
import { courseGradeStatus, type CourseGradeStatus, type SchemeCategory, type GradeItemInput, type GradeOverride } from '@/lib/grades'
import { computeExamReadiness, type ExamReadiness } from '@/lib/readiness'
import { dateKeyInTimeZone, addDaysToDateKey, isValidTimeZone } from '@/lib/time'

// ─────────────────────────────────────────────────────────────────────────────
// Semester standing (S15) — one honest verdict per course, composed from the
// signals the system already computes: grade risk (S1), exam readiness (I11),
// study consistency (review_logs), and overdue homework. Answers "am I on
// track this semester?" without making the student assemble it from five tabs.
// ─────────────────────────────────────────────────────────────────────────────

export type CourseVerdict = 'on_track' | 'at_risk' | 'critical'

export type VerdictInputs = {
  gradeAtRisk: boolean
  /** B- already unreachable (worst grade state). */
  gradeSunk: boolean
  /** Readiness % for an exam within 14 days; null = no near exam. */
  nearExamReadiness: number | null
  overdueCount: number
  reviews14d: number
}

/** Pure verdict rules (unit-tested):
 *  CRITICAL — the B- is gone, or the grade is at risk AND a near exam is badly
 *  unprepared (<50%), or the grade is at risk while ≥3 assignments sit overdue.
 *  AT RISK — any single alarm: grade risk, a near exam under 60% ready, ≥3
 *  overdue, or a totally idle two weeks (0 reviews) with a near exam.
 *  ON TRACK — otherwise. */
export function courseVerdict(i: VerdictInputs): CourseVerdict {
  if (i.gradeSunk) return 'critical'
  if (i.gradeAtRisk && i.nearExamReadiness !== null && i.nearExamReadiness < 50) return 'critical'
  if (i.gradeAtRisk && i.overdueCount >= 3) return 'critical'

  if (i.gradeAtRisk) return 'at_risk'
  if (i.nearExamReadiness !== null && i.nearExamReadiness < 60) return 'at_risk'
  if (i.overdueCount >= 3) return 'at_risk'
  if (i.nearExamReadiness !== null && i.reviews14d === 0) return 'at_risk'

  return 'on_track'
}

export type CourseStanding = {
  course_id: string
  course_name: string
  verdict: CourseVerdict
  grade: CourseGradeStatus | null
  next_exam: { date: string; days_away: number; readiness_pct: number; weakest: string | null } | null
  overdue_count: number
  reviews_14d: number
  /** One line of "why" for the card. */
  reason: string
}

export async function computeSemesterStanding(userId: string): Promise<CourseStanding[]> {
  const service = createServiceClient()

  const { data: userRow } = await service.from('users').select('timezone').eq('user_id', userId).maybeSingle()
  const tz = isValidTimeZone(userRow?.timezone) ? userRow!.timezone as string : 'UTC'
  const today = dateKeyInTimeZone(new Date(), tz)
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const overdueFloor = addDaysToDateKey(today, -30)

  const { data: courses } = await service
    .from('courses').select('course_id, name')
    .eq('user_id', userId).eq('active_status', 'active')
  const courseRows = (courses ?? []) as { course_id: string; name: string }[]
  if (courseRows.length === 0) return []
  const courseIds = courseRows.map(c => c.course_id)

  const [readiness, { data: schemeRows }, { data: itemRows }, { data: overdueRows }, { data: reviewRows }, { data: manualRows }] = await Promise.all([
    computeExamReadiness(userId, { horizonDays: 14 }).catch(() => [] as ExamReadiness[]),
    service.from('course_grade_schemes').select('course_id, category, weight_pct').eq('user_id', userId).in('course_id', courseIds),
    service.from('grade_items').select('course_id, category, points_earned, points_possible').eq('user_id', userId).in('course_id', courseIds).eq('confirmed', true),
    service.from('assignments').select('course_id').eq('user_id', userId).eq('completion_status', 'pending').gte('due_date', overdueFloor).lt('due_date', today),
    // course-scoped consistency: reviews join flashcards for the course id
    service.from('review_logs').select('card_id, reviewed_at, flashcards!inner(course_id)').eq('user_id', userId).gte('reviewed_at', fourteenDaysAgo),
    service.from('course_grade_manual').select('course_id, current_pct, remaining_weight_pct').eq('user_id', userId).in('course_id', courseIds),
  ])

  const readinessByCourse = new Map<string, ExamReadiness>()
  for (const r of readiness) {
    // keep the NEAREST exam per course (computeExamReadiness is date-ordered)
    if (!readinessByCourse.has(r.course_id)) readinessByCourse.set(r.course_id, r)
  }

  const schemesByCourse = new Map<string, SchemeCategory[]>()
  for (const s of (schemeRows ?? []) as { course_id: string; category: string; weight_pct: number }[]) {
    const arr = schemesByCourse.get(s.course_id) ?? []
    arr.push({ category: s.category, weight_pct: Number(s.weight_pct) })
    schemesByCourse.set(s.course_id, arr)
  }
  const itemsByCourse = new Map<string, GradeItemInput[]>()
  for (const i of (itemRows ?? []) as { course_id: string; category: string | null; points_earned: number | null; points_possible: number }[]) {
    const arr = itemsByCourse.get(i.course_id) ?? []
    arr.push({ category: i.category, points_earned: i.points_earned !== null ? Number(i.points_earned) : null, points_possible: Number(i.points_possible) })
    itemsByCourse.set(i.course_id, arr)
  }
  const overdueByCourse = new Map<string, number>()
  for (const o of (overdueRows ?? []) as { course_id: string }[]) {
    overdueByCourse.set(o.course_id, (overdueByCourse.get(o.course_id) ?? 0) + 1)
  }
  const reviewsByCourse = new Map<string, number>()
  for (const r of (reviewRows ?? []) as unknown as { flashcards: { course_id: string } }[]) {
    const cid = r.flashcards?.course_id
    if (cid) reviewsByCourse.set(cid, (reviewsByCourse.get(cid) ?? 0) + 1)
  }
  const overrideByCourse = new Map<string, GradeOverride>()
  for (const m of (manualRows ?? []) as { course_id: string; current_pct: number; remaining_weight_pct: number }[]) {
    overrideByCourse.set(m.course_id, { current_pct: Number(m.current_pct), remaining_weight_pct: Number(m.remaining_weight_pct) })
  }

  return courseRows.map(course => {
    const grade = courseGradeStatus(schemesByCourse.get(course.course_id) ?? [], itemsByCourse.get(course.course_id) ?? [], overrideByCourse.get(course.course_id) ?? null)
    const nearExam = readinessByCourse.get(course.course_id) ?? null
    const overdue = overdueByCourse.get(course.course_id) ?? 0
    const reviews14d = reviewsByCourse.get(course.course_id) ?? 0

    const verdict = courseVerdict({
      gradeAtRisk: grade?.at_risk ?? false,
      gradeSunk: grade !== null && grade.needed_for_b !== null && !grade.b_reachable,
      nearExamReadiness: nearExam?.readiness_pct ?? null,
      overdueCount: overdue,
      reviews14d,
    })

    // One concrete "why" line, worst signal first.
    let reason: string
    if (grade && grade.needed_for_b !== null && !grade.b_reachable) {
      reason = `At ${grade.current_pct}% — a B is out of reach; every remaining point counts.`
    } else if (grade?.at_risk && grade.needed_for_b !== null && grade.needed_for_b > 0) {
      reason = `At ${grade.current_pct}% — needs ${grade.needed_for_b}% on remaining work to keep a B.`
    } else if (nearExam && nearExam.readiness_pct < 60) {
      reason = `Exam in ${nearExam.days_away} day${nearExam.days_away === 1 ? '' : 's'} at ~${nearExam.readiness_pct}% ready${nearExam.weakest_topics[0] ? ` — weakest: ${nearExam.weakest_topics[0].name}` : ''}.`
    } else if (overdue >= 3) {
      reason = `${overdue} assignments overdue.`
    } else if (nearExam) {
      reason = `Exam in ${nearExam.days_away} day${nearExam.days_away === 1 ? '' : 's'} — ~${nearExam.readiness_pct}% ready.`
    } else if (grade) {
      reason = `Sitting at ${grade.current_pct}%${reviews14d > 0 ? ` · ${reviews14d} reviews this fortnight` : ''}.`
    } else {
      reason = reviews14d > 0 ? `${reviews14d} reviews this fortnight — keep it up.` : 'No graded work or near exams yet.'
    }

    return {
      course_id: course.course_id,
      course_name: course.name,
      verdict,
      grade,
      next_exam: nearExam
        ? { date: nearExam.date, days_away: nearExam.days_away, readiness_pct: nearExam.readiness_pct, weakest: nearExam.weakest_topics[0]?.name ?? null }
        : null,
      overdue_count: overdue,
      reviews_14d: reviews14d,
      reason,
    }
  })
}
