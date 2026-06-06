import { createServiceClient } from '@/lib/supabase/server'
import { effectiveMastery } from '@/lib/mastery'
import { dateKeyInTimeZone, daysBetweenDateKeys, isValidTimeZone } from '@/lib/time'

// ─────────────────────────────────────────────────────────────────────────────
// Exam readiness (I11) — the student's real question is "am I ready for this
// exam, and what do I do about it?" Cogni had every input (exam topic coverage,
// professor weights, decayed mastery, practice-test history) but never combined
// them into that answer. This is a deterministic 0–100 readiness score per
// upcoming exam plus the prescription (weakest covered topics).
//
//   readiness = 60% weighted effective mastery over the exam's topics
//             + 25% recent practice-test performance (falls back to mastery)
//             + 15% content coverage (do the topics even have study material?)
// ─────────────────────────────────────────────────────────────────────────────

export type ExamReadiness = {
  exam_id: string
  course_id: string
  course_name: string
  date: string
  days_away: number
  grade_weight: number | null
  readiness_pct: number
  weakest_topics: { topic_id: string; name: string; mastery_pct: number }[]
}

export async function computeExamReadiness(
  userId: string,
  opts?: { courseId?: string; horizonDays?: number },
): Promise<ExamReadiness[]> {
  const service = createServiceClient()

  const { data: userRow } = await service.from('users').select('timezone').eq('user_id', userId).maybeSingle()
  const tz = isValidTimeZone(userRow?.timezone) ? userRow!.timezone as string : 'UTC'
  const today = dateKeyInTimeZone(new Date(), tz)

  let examQuery = service
    .from('exams')
    .select('exam_id, course_id, date, grade_weight, topics_covered, courses(name)')
    .eq('user_id', userId)
    .gte('date', today)
    .order('date', { ascending: true })
  if (opts?.courseId) examQuery = examQuery.eq('course_id', opts.courseId)
  const { data: exams } = await examQuery

  const upcoming = ((exams ?? []) as {
    exam_id: string; course_id: string; date: string; grade_weight: number | null
    topics_covered: string[] | null; courses: { name: string } | { name: string }[] | null
  }[]).filter(e => daysBetweenDateKeys(today, e.date) <= (opts?.horizonDays ?? 45))

  if (upcoming.length === 0) return []

  const courseIds = [...new Set(upcoming.map(e => e.course_id))]
  const [{ data: topics }, { data: masteryRows }, { data: recentTests }] = await Promise.all([
    service.from('topics').select('topic_id, course_id, name, professor_weight, content_coverage').eq('user_id', userId).in('course_id', courseIds),
    service.from('topic_mastery').select('topic_id, mastery_score, last_updated').eq('user_id', userId),
    service.from('practice_test_results').select('course_id, score_pct, created_at').eq('user_id', userId).in('course_id', courseIds).order('created_at', { ascending: false }).limit(30),
  ])

  type TopicRow = { topic_id: string; course_id: string; name: string; professor_weight: number | null; content_coverage: number | null }
  const topicById = new Map<string, TopicRow>(
    ((topics ?? []) as TopicRow[]).map(t => [t.topic_id, t])
  )
  const topicsByCourse = new Map<string, string[]>()
  for (const t of (topics ?? []) as { topic_id: string; course_id: string }[]) {
    const arr = topicsByCourse.get(t.course_id) ?? []
    arr.push(t.topic_id)
    topicsByCourse.set(t.course_id, arr)
  }
  const masteryById = new Map<string, number>()
  for (const m of (masteryRows ?? []) as { topic_id: string; mastery_score: number | null; last_updated: string | null }[]) {
    masteryById.set(m.topic_id, effectiveMastery(m.mastery_score, m.last_updated))
  }
  // Most recent practice-test score per course (already newest-first).
  const recentScoreByCourse = new Map<string, number>()
  for (const r of (recentTests ?? []) as { course_id: string; score_pct: number | null }[]) {
    if (!recentScoreByCourse.has(r.course_id) && r.score_pct !== null) {
      recentScoreByCourse.set(r.course_id, Number(r.score_pct) / 100)
    }
  }

  return upcoming.map(exam => {
    // The exam's topics — fall back to the whole course when the syllabus
    // didn't pin specific topics to the exam.
    const examTopicIds = (exam.topics_covered && exam.topics_covered.length > 0
      ? exam.topics_covered.filter(id => topicById.has(id))
      : topicsByCourse.get(exam.course_id) ?? [])

    let weightSum = 0
    let masterySum = 0
    let coverageSum = 0
    const perTopic: { topic_id: string; name: string; mastery_pct: number; weight: number }[] = []
    for (const id of examTopicIds) {
      const t = topicById.get(id)!
      const w = Number(t.professor_weight ?? 0.5)
      const m = masteryById.get(id) ?? 0
      weightSum += w
      masterySum += m * w
      coverageSum += Number(t.content_coverage ?? 0)
      perTopic.push({ topic_id: id, name: t.name, mastery_pct: Math.round(m * 100), weight: w })
    }

    const weightedMastery = weightSum > 0 ? masterySum / weightSum : 0
    const coverage = examTopicIds.length > 0 ? coverageSum / examTopicIds.length : 0
    const testScore = recentScoreByCourse.get(exam.course_id) ?? weightedMastery

    const readiness = 0.6 * weightedMastery + 0.25 * testScore + 0.15 * Math.min(1, coverage)

    const courseName = Array.isArray(exam.courses)
      ? (exam.courses[0]?.name ?? 'Course')
      : (exam.courses?.name ?? 'Course')

    return {
      exam_id: exam.exam_id,
      course_id: exam.course_id,
      course_name: courseName,
      date: exam.date,
      days_away: daysBetweenDateKeys(today, exam.date),
      grade_weight: exam.grade_weight !== null ? Number(exam.grade_weight) : null,
      readiness_pct: Math.round(readiness * 100),
      // Prescription: the weakest high-weight covered topics — what to fix FIRST.
      weakest_topics: perTopic
        .sort((a, b) => (a.mastery_pct - b.mastery_pct) || (b.weight - a.weight))
        .slice(0, 3)
        .map(({ topic_id, name, mastery_pct }) => ({ topic_id, name, mastery_pct })),
    }
  })
}
