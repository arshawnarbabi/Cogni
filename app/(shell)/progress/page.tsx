import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ProgressClient } from './_client'
import { dateKeyInTimeZone } from '@/lib/time'

type MasteryRow = { mastery_score: number | null }
type ProgressTopicRow = {
  topic_id: string
  name: string
  topic_mastery?: MasteryRow[] | null
}
type ProgressCourseRow = {
  course_id: string
  name: string
  icon?: string | null
  icon_color?: string | null
  topics?: ProgressTopicRow[] | null
}
type TestResultRow = {
  result_id: string
  test_type: 'practice_quiz' | 'simulated_exam'
  score_pct: number | null
  question_count: number
  correct_count: number
  topic_filter: string | null
  created_at: string
  courses?: { name: string } | { name: string }[] | null
}
type MasteryHistoryRow = {
  mastery_score: number | null
  recorded_at: string
  topic_id: string
  topics?: { course_id: string } | null
}

// ── Linear regression ──────────────────────────────────────────────────────────
function linearRegression(points: { x: number; y: number }[]) {
  const n = points.length
  if (n < 2) return null
  const sumX = points.reduce((s, p) => s + p.x, 0)
  const sumY = points.reduce((s, p) => s + p.y, 0)
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0)
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0)
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return null
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  const sse = points.reduce((s, p) => {
    const predicted = slope * p.x + intercept
    return s + (p.y - predicted) ** 2
  }, 0)
  const se = n > 2 ? Math.sqrt(sse / (n - 2)) : Math.sqrt(sse)
  return { slope, intercept, se }
}

export default async function ProgressPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()
  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', user.id)
    .single()
  const today = dateKeyInTimeZone(new Date(), userRow?.timezone ?? 'UTC')
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [
    { data: courses },
    { data: historyRows },
    { data: flashcardRows },
    { data: gradedExams },
    { data: testResults },
    { data: reviewedCardRows },
  ] = await Promise.all([
    service
      .from('courses')
      .select(`
        course_id,
        name,
        icon,
        icon_color,
        topics (
          topic_id,
          name,
          topic_mastery ( mastery_score )
        )
      `)
      .eq('user_id', user.id)
      .eq('active_status', 'active')
      .order('created_at', { ascending: true }),
    service
      .from('mastery_history')
      .select('mastery_score, recorded_at, topic_id, topics ( course_id )')
      .eq('user_id', user.id)
      .gte('recorded_at', thirtyDaysAgo)
      .order('recorded_at', { ascending: true }),
    service
      .from('flashcards')
      .select('card_id')
      .eq('user_id', user.id)
      .lte('fsrs_next_review_date', today),
    service
      .from('exams')
      .select('exam_id, course_id, date, student_score')
      .eq('user_id', user.id)
      .not('student_score', 'is', null)
      .order('date', { ascending: true }),
    service
      .from('practice_test_results')
      .select('result_id, test_type, score_pct, question_count, correct_count, topic_filter, created_at, courses ( name )')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    // "Started" signal: any card the student has actually reviewed (fsrs_reps > 0).
    service
      .from('flashcards')
      .select('course_id, topic_id')
      .eq('user_id', user.id)
      .gt('fsrs_reps', 0),
  ])

  // A course/topic is "started" once the student has reviewed at least one of its
  // cards. This separates a genuinely-new course (0% because untouched) from a
  // struggling one (0% because reviewed and failing) — so a fresh upload is framed
  // as "ready to begin," not "you're failing."
  const startedCourses = new Set<string>()
  const startedTopics = new Set<string>()
  for (const r of (reviewedCardRows ?? []) as { course_id: string; topic_id: string | null }[]) {
    startedCourses.add(r.course_id)
    if (r.topic_id) startedTopics.add(r.topic_id)
  }

  // ── Build trend map: courseId → date → mastery[] ───────────────────────────
  const trendMap = new Map<string, Map<string, number[]>>()
  for (const row of (historyRows ?? []) as MasteryHistoryRow[]) {
    const courseId = row.topics?.course_id
    if (!courseId) continue
    const dateStr = (row.recorded_at as string).split('T')[0]
    if (!trendMap.has(courseId)) trendMap.set(courseId, new Map())
    const dayMap = trendMap.get(courseId)!
    if (!dayMap.has(dateStr)) dayMap.set(dateStr, [])
    dayMap.get(dateStr)!.push(Number(row.mastery_score))
  }

  // ── Build mastery-at-date lookup for exam prediction ───────────────────────
  // topic_id → sorted [{date, score}]
  const masteryAtDate = new Map<string, { date: string; score: number }[]>()
  for (const row of historyRows ?? []) {
    const tid = row.topic_id as string
    if (!masteryAtDate.has(tid)) masteryAtDate.set(tid, [])
    masteryAtDate.get(tid)!.push({
      date: (row.recorded_at as string).split('T')[0],
      score: Number(row.mastery_score),
    })
  }

  function getAvgMasteryAtDate(topicIds: string[], targetDate: string): number | null {
    const scores: number[] = []
    for (const tid of topicIds) {
      const entries = masteryAtDate.get(tid) ?? []
      // Find closest entry on or before targetDate
      const before = entries.filter(e => e.date <= targetDate)
      if (before.length > 0) scores.push(before[before.length - 1].score)
    }
    return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  }

  // ── Group graded exams by course ───────────────────────────────────────────
  const examsByCourse = new Map<string, { date: string; score: number }[]>()
  for (const exam of gradedExams ?? []) {
    if (exam.student_score == null) continue
    const cid = exam.course_id as string
    if (!examsByCourse.has(cid)) examsByCourse.set(cid, [])
    examsByCourse.get(cid)!.push({ date: exam.date as string, score: Number(exam.student_score) })
  }

  // ── Shape courses ──────────────────────────────────────────────────────────
  const shapedCourses = ((courses ?? []) as ProgressCourseRow[]).map((c) => {
    const topics = Array.isArray(c.topics) ? c.topics : []
    const topicIds = topics.map((t) => t.topic_id)

    // Current mastery
    const masteryScores = topics
      .map((t) => {
        const rows = Array.isArray(t.topic_mastery) ? t.topic_mastery : []
        return rows[0]?.mastery_score != null ? Number(rows[0].mastery_score) : null
      })
      .filter((v: number | null): v is number => v !== null)

    const avgMastery = masteryScores.length > 0
      ? masteryScores.reduce((a: number, b: number) => a + b, 0) / masteryScores.length
      : 0

    // Trend data
    const dayMap = trendMap.get(c.course_id as string)
    let trend: { date: string; mastery: number }[] = dayMap
      ? Array.from(dayMap.entries())
          .map(([date, scores]) => ({
            date,
            mastery: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100),
          }))
          .sort((a, b) => a.date.localeCompare(b.date))
      : []

    // Always include today's current mastery as the last point
    const todayPoint = { date: today, mastery: Math.round(avgMastery * 100) }
    if (trend.length === 0 || trend[trend.length - 1].date !== today) {
      trend = [...trend, todayPoint]
    }

    // Exam score prediction
    const cExams = examsByCourse.get(c.course_id as string) ?? []
    type Prediction =
      | { type: 'prediction'; low: number; high: number; n: number }
      | { type: 'readiness'; label: 'on_track' | 'needs_more_time' | 'behind' | 'not_started' }

    let prediction: Prediction | null = null

    if (cExams.length >= 2) {
      const points = cExams
        .map(exam => {
          const mastery = getAvgMasteryAtDate(topicIds, exam.date)
          return mastery !== null ? { x: mastery * 100, y: exam.score } : null
        })
        .filter((p): p is { x: number; y: number } => p !== null)

      if (points.length >= 2) {
        const reg = linearRegression(points)
        if (reg) {
          const currentPct = avgMastery * 100
          const predicted = reg.slope * currentPct + reg.intercept
          prediction = {
            type: 'prediction',
            low: Math.round(Math.max(0, predicted - reg.se)),
            high: Math.round(Math.min(100, predicted + reg.se)),
            n: points.length,
          }
        }
      }
    }

    // Fall back to readiness indicator. A course with no reviews yet is "not_started"
    // (neutral/encouraging), NOT "behind" — 0% from never studying ≠ 0% from failing.
    if (!prediction) {
      const started = startedCourses.has(c.course_id as string)
      const label: 'on_track' | 'needs_more_time' | 'behind' | 'not_started' =
        !started ? 'not_started'
          : avgMastery >= 0.65 ? 'on_track'
          : avgMastery >= 0.40 ? 'needs_more_time'
          : 'behind'
      prediction = { type: 'readiness', label }
    }

    // Weak topics: only surface topics the student has actually STUDIED and is weak
    // on (mastery < 0.5). Never flag an untouched topic as a "weak area" — that's
    // just "not started yet," and labeling it weak is what made a fresh upload look
    // like failure.
    const weakTopics = topics
      .map((t) => {
        const rows = Array.isArray(t.topic_mastery) ? t.topic_mastery : []
        return { topic_id: t.topic_id, name: t.name, mastery: rows[0]?.mastery_score != null ? Number(rows[0].mastery_score) : 0 }
      })
      .filter((t) => startedTopics.has(t.topic_id) && t.mastery < 0.5)
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, 5)
      .map((t) => ({ name: t.name, mastery: t.mastery })) as { name: string; mastery: number }[]

    return {
      course_id: c.course_id as string,
      name: c.name as string,
      icon: (c.icon as string | null) ?? null,
      icon_color: (c.icon_color as string | null) ?? null,
      topic_count: topics.length,
      avg_mastery: avgMastery,
      trend,
      prediction,
      weak_topics: weakTopics,
    }
  })

  // ── Global weak areas (across all courses) ─────────────────────────────────
  const allWeakAreas: { topic_name: string; course_name: string; mastery: number }[] = []
  for (const c of (courses ?? []) as ProgressCourseRow[]) {
    for (const t of Array.isArray(c.topics) ? c.topics : []) {
      const rows = Array.isArray(t.topic_mastery) ? t.topic_mastery : []
      const score = rows[0]?.mastery_score != null ? Number(rows[0].mastery_score) : 0
      // Only studied-and-weak topics — an untouched topic isn't a "weak area."
      if (startedTopics.has(t.topic_id) && score < 0.5) {
        allWeakAreas.push({ topic_name: t.name, course_name: c.name, mastery: score })
      }
    }
  }
  allWeakAreas.sort((a, b) => a.mastery - b.mastery)
  const topWeakAreas = allWeakAreas.slice(0, 8)

  return (
    <ProgressClient
      courses={shapedCourses}
      weakAreas={topWeakAreas}
      dueToday={flashcardRows?.length ?? 0}
      testResults={((testResults ?? []) as TestResultRow[]).map((r) => ({
        result_id: r.result_id,
        test_type: r.test_type,
        score_pct: r.score_pct,
        question_count: r.question_count,
        correct_count: r.correct_count,
        topic_filter: r.topic_filter,
        created_at: r.created_at,
        course_name: Array.isArray(r.courses) ? r.courses[0]?.name ?? null : r.courses?.name ?? null,
      }))}
    />
  )
}
