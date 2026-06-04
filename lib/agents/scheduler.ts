import { createServiceClient } from '@/lib/supabase/server'
import { writeStudyBlocksToCalendar } from '@/lib/calendar'
import { addDaysToDateKey, dateKeyInTimeZone, daysBetweenDateKeys } from '@/lib/time'
import { prettifyTitle } from '@/lib/filename'

export type TaskItem =
  | {
      type: 'flashcard_review'
      course_id: string
      course_name: string
      topic_ids: string[]
      card_count: number
      duration_minutes: number
      priority_score: number
      reason?: string
      order: number
    }
  | {
      type: 'homework'
      course_id: string
      course_name: string
      assignment_id: string
      title: string
      due_date: string
      overdue: boolean
      priority_score?: number
      reason?: string
      order: number
      completion_status?: 'pending' | 'complete' | 'late'
    }
  | {
      type: 'practice_quiz'
      course_id: string
      course_name: string
      reason: string
      priority_score?: number
      order: number
    }
  | {
      type: 'insight'
      text: string
      order: number
    }

function examProximityMultiplier(daysToExam: number | null): number {
  if (daysToExam === null || daysToExam > 30) return 1
  if (daysToExam > 14) return 1.5
  if (daysToExam > 7) return 2
  if (daysToExam > 3) return 3
  return 5
}

// 0–45 urgency bonus from exam proximity, on the same 0–100 scale the UNIFIED task
// ordering uses — so an exam-imminent review/quiz can out-rank routine work across
// task types (not just within its own type).
function examUrgencyBonus(daysToExam: number | null): number {
  if (daysToExam === null) return 0
  if (daysToExam <= 3) return 45
  if (daysToExam <= 7) return 30
  if (daysToExam <= 14) return 18
  if (daysToExam <= 30) return 8
  return 0
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function buildInsight(params: {
  courses: { name: string }[]
  nextExam: { courseName: string; daysAway: number } | null
  weakestTopic: { topicName: string; courseName: string; mastery: number } | null
  totalDueCards: number
  pendingHomework: number
  hasStarted: boolean
}): string {
  const { nextExam, weakestTopic, totalDueCards, pendingHomework, hasStarted } = params

  if (nextExam && nextExam.daysAway <= 3) {
    return `Your ${nextExam.courseName} exam is in ${nextExam.daysAway} day${nextExam.daysAway === 1 ? '' : 's'} — focus everything there today.`
  }
  if (nextExam && nextExam.daysAway <= 7) {
    const weak = hasStarted && weakestTopic ? ` Start with ${weakestTopic.topicName}.` : ''
    return `${nextExam.courseName} exam in ${nextExam.daysAway} days — prioritize review sessions now.${weak}`
  }
  // Brand-new: nothing reviewed yet. Frame it as a fresh start with a concrete next
  // step — NOT as a "weakest area" (every topic is 0% only because it's untouched).
  if (!hasStarted) {
    if (pendingHomework > 0) {
      return `You have ${pendingHomework} assignment${pendingHomework > 1 ? 's' : ''} to start with — then run a flashcard review to begin building mastery.`
    }
    if (totalDueCards > 0) {
      return `Your study materials are ready — start a flashcard review to begin building mastery across your topics.`
    }
    return `Your courses are set up — generate some flashcards and start a study session to begin.`
  }
  if (weakestTopic && weakestTopic.mastery < 0.3) {
    return `Your weakest area is ${weakestTopic.topicName} in ${weakestTopic.courseName} — it's a high-weight topic worth focusing on.`
  }
  if (pendingHomework > 0) {
    return `You have ${pendingHomework} assignment${pendingHomework > 1 ? 's' : ''} due — clear those first, then review your flashcards.`
  }
  if (totalDueCards > 20) {
    return `${totalDueCards} cards are due for review across your courses — a solid session today keeps you ahead.`
  }
  if (totalDueCards === 0) {
    return `You're all caught up on flashcards — great time to run a practice quiz and test your knowledge.`
  }
  return `Keep up your review habit — consistency is what drives long-term retention.`
}

export async function runScheduler(userId: string): Promise<void> {
  const service = createServiceClient()

  const { data: userRow } = await service
    .from('users')
    .select('session_length_preference, timezone')
    .eq('user_id', userId)
    .single()

  const sessionMinutes = userRow?.session_length_preference ?? 45
  const timeZone = userRow?.timezone ?? 'UTC'
  const today = dateKeyInTimeZone(new Date(), timeZone)

  const { data: courses } = await service
    .from('courses')
    .select('course_id, name')
    .eq('user_id', userId)
    .eq('active_status', 'active')

  if (!courses || courses.length === 0) return

  const { data: exams } = await service
    .from('exams')
    .select('course_id, date')
    .eq('user_id', userId)
    .gte('date', today)
    .order('date', { ascending: true })

  const nextExamByCourse: Record<string, number> = {}
  for (const exam of exams ?? []) {
    const days = daysBetweenDateKeys(today, exam.date)
    if (!(exam.course_id in nextExamByCourse) || days < nextExamByCourse[exam.course_id]) {
      nextExamByCourse[exam.course_id] = days
    }
  }

  type CourseScore = {
    course_id: string
    course_name: string
    priority: number
    topic_ids: string[]
    card_count: number
    avg_mastery: number
    weakest_topic: { name: string; mastery: number } | null
  }

  const scored: CourseScore[] = []

  // Batch the three per-course queries into three queries across all courses.
  // Previously: 3 × N round trips for N courses. Now: 3 round trips total.
  const courseIds = courses.map((c: { course_id: string; name: string }) => c.course_id)

  const [topicsResult, dueCardsResult] = await Promise.all([
    service
      .from('topics')
      .select('course_id, topic_id, name, professor_weight')
      .eq('user_id', userId)
      .in('course_id', courseIds),
    service
      .from('flashcards')
      .select('card_id, topic_id, course_id')
      .eq('user_id', userId)
      .in('course_id', courseIds)
      .lte('fsrs_next_review_date', today),
  ])

  const allTopics = (topicsResult.data ?? []) as { course_id: string; topic_id: string; name: string; professor_weight: number }[]
  const topicsByCourse = new Map<string, typeof allTopics>()
  for (const t of allTopics) {
    const arr = topicsByCourse.get(t.course_id) ?? []
    arr.push(t)
    topicsByCourse.set(t.course_id, arr)
  }

  const allTopicIds = allTopics.map(t => t.topic_id)
  const { data: masteryRows } = allTopicIds.length > 0
    ? await service
        .from('topic_mastery')
        .select('topic_id, mastery_score')
        .eq('user_id', userId)
        .in('topic_id', allTopicIds)
    : { data: [] as { topic_id: string; mastery_score: number | null }[] }

  const masteryMap: Record<string, number> = {}
  for (const m of (masteryRows ?? []) as { topic_id: string; mastery_score: number | null }[]) {
    masteryMap[m.topic_id] = Number(m.mastery_score ?? 0)
  }

  const dueCardsByCourse = new Map<string, { card_id: string; topic_id: string | null }[]>()
  for (const c of (dueCardsResult.data ?? []) as { card_id: string; topic_id: string | null; course_id: string }[]) {
    const arr = dueCardsByCourse.get(c.course_id) ?? []
    arr.push({ card_id: c.card_id, topic_id: c.topic_id })
    dueCardsByCourse.set(c.course_id, arr)
  }

  for (const course of courses) {
    const multiplier = examProximityMultiplier(nextExamByCourse[course.course_id] ?? null)
    const topics = topicsByCourse.get(course.course_id) ?? []
    if (topics.length === 0) continue

    const topicIds = topics.map(t => t.topic_id)

    let totalPriority = 0
    let totalMastery = 0
    let weakestTopic: { name: string; mastery: number } | null = null

    for (const topic of topics) {
      const pw = Number(topic.professor_weight ?? 0.5)
      const ms = masteryMap[topic.topic_id] ?? 0
      const deficit = Math.max(0, pw - ms)
      totalPriority += deficit * pw * multiplier
      totalMastery += ms
      if (pw >= 0.5 && (weakestTopic === null || ms < weakestTopic.mastery)) {
        weakestTopic = { name: topic.name, mastery: ms }
      }
    }
    const avgPriority = totalPriority / topics.length
    const avgMastery = totalMastery / topics.length

    const dueCards = dueCardsByCourse.get(course.course_id) ?? []
    const dueCount = dueCards.length
    const dueTopicIds = [...new Set(dueCards.map(c => c.topic_id).filter(Boolean) as string[])]

    if (dueCount === 0 && avgPriority < 0.01) continue

    scored.push({
      course_id: course.course_id,
      course_name: course.name,
      priority: avgPriority,
      topic_ids: dueTopicIds.length > 0 ? dueTopicIds : topicIds.slice(0, 5),
      card_count: dueCount,
      avg_mastery: avgMastery,
      weakest_topic: weakestTopic,
    })
  }

  const tasks: TaskItem[] = []

  // Flashcard review blocks — only emit for courses that actually have due cards.
  // A zero-card course (e.g. high professor_weight + low mastery) would otherwise
  // surface a misleading "Flashcard review / No cards yet" task and dilute the
  // session-minute allocation owed to genuinely reviewable courses.
  const reviewable = scored.filter(c => c.card_count > 0)
  if (reviewable.length > 0) {
    const totalPriority = reviewable.reduce((sum, c) => sum + c.priority, 0)
    reviewable
      .sort((a, b) => b.priority - a.priority)
      .forEach((course, i) => {
        const share = totalPriority > 0 ? course.priority / totalPriority : 1 / reviewable.length
        const cappedShare = Math.min(0.7, Math.max(share, reviewable.length === 1 ? 1 : 0.1))
        const duration = Math.round(sessionMinutes * cappedShare)
        if (duration < 5) return
        const daysToExam = nextExamByCourse[course.course_id] ?? null
        // Unified 0–100 urgency: mastery gap + exam proximity (comparable across task types).
        const urgency = clamp(20 + examUrgencyBonus(daysToExam) + (1 - course.avg_mastery) * 25, 0, 95)
        // One-line "why": cards due + the single strongest reason.
        let why = `${course.card_count} card${course.card_count === 1 ? '' : 's'} due`
        if (daysToExam !== null && daysToExam <= 14) {
          why += ` · exam in ${daysToExam} day${daysToExam === 1 ? '' : 's'}`
        } else if (course.weakest_topic && course.weakest_topic.mastery > 0 && course.weakest_topic.mastery < 0.5) {
          why += ` · focus ${course.weakest_topic.name}`
        }
        tasks.push({
          type: 'flashcard_review',
          course_id: course.course_id,
          course_name: course.course_name,
          topic_ids: course.topic_ids,
          card_count: course.card_count,
          duration_minutes: duration,
          priority_score: Math.round(urgency),
          reason: why,
          order: i + 1,
        })
      })
  }

  // Practice quiz tasks — one per course where it makes sense
  const quizCandidates: { course_id: string; course_name: string; reason: string; priority: number }[] = []

  // Batch per-course lookups into two queries total.
  const [quizHistoryResult, allCardsResult] = await Promise.all([
    service
      .from('practice_test_results')
      .select('course_id, created_at')
      .eq('user_id', userId)
      .in('course_id', courseIds)
      .order('created_at', { ascending: false }),
    service
      .from('flashcards')
      .select('course_id')
      .eq('user_id', userId)
      .in('course_id', courseIds),
  ])

  const latestQuizByCourse = new Map<string, string>()
  for (const q of (quizHistoryResult.data ?? []) as { course_id: string; created_at: string }[]) {
    if (!latestQuizByCourse.has(q.course_id)) latestQuizByCourse.set(q.course_id, q.created_at)
  }

  const cardCountByCourse = new Map<string, number>()
  for (const c of (allCardsResult.data ?? []) as { course_id: string }[]) {
    cardCountByCourse.set(c.course_id, (cardCountByCourse.get(c.course_id) ?? 0) + 1)
  }

  for (const course of courses) {
    const courseScore = scored.find(s => s.course_id === course.course_id)
    const daysToExam = nextExamByCourse[course.course_id] ?? null
    const avgMastery = courseScore?.avg_mastery ?? 0

    const latestQuizAt = latestQuizByCourse.get(course.course_id)
    const daysSinceQuiz = latestQuizAt
      ? Math.floor((Date.now() - new Date(latestQuizAt).getTime()) / 86400000)
      : 999

    const hasEnoughCards = (cardCountByCourse.get(course.course_id) ?? 0) >= 5

    const examSoon = daysToExam !== null && daysToExam <= 14
    const readyForQuiz = avgMastery >= 0.3 && daysSinceQuiz > 5 && hasEnoughCards

    if (examSoon || readyForQuiz) {
      let reason = ''
      if (daysToExam !== null && daysToExam <= 3) {
        reason = `Exam in ${daysToExam} day${daysToExam === 1 ? '' : 's'} — test yourself now`
      } else if (daysToExam !== null && daysToExam <= 7) {
        reason = `Exam in ${daysToExam} days — practice makes perfect`
      } else if (daysToExam !== null && daysToExam <= 14) {
        reason = `Exam coming up — check your retention`
      } else {
        reason = daysSinceQuiz > 14 ? `No quiz in ${daysSinceQuiz} days — time to test yourself` : `Mastery strong enough to test`
      }
      quizCandidates.push({
        course_id: course.course_id,
        course_name: course.name,
        reason,
        // Unified 0–100 urgency: an exam-imminent quiz ranks high; a routine
        // "you're ready to test" quiz stays low (below active review work).
        priority: examSoon ? clamp(40 + examUrgencyBonus(daysToExam), 40, 88) : 22,
      })
    }
  }

  // Add quiz tasks (max 2)
  quizCandidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 2)
    .forEach((c, i) => {
      tasks.push({
        type: 'practice_quiz',
        course_id: c.course_id,
        course_name: c.course_name,
        reason: c.reason,
        priority_score: Math.round(c.priority),
        order: tasks.length + i + 1,
      })
    })

  // Homework blocks — due today or recently overdue, not yet completed. Bound the
  // overdue window to the last 14 days and cap the count so an old/backlogged account
  // (or a batch of past-due uploads) can't bury Today under a wall of red "Overdue".
  const tomorrowStr = addDaysToDateKey(today, 1)
  const overdueFloor = addDaysToDateKey(today, -14)

  const { data: assignments } = await service
    .from('assignments')
    .select('assignment_id, name, due_date, course_id')
    .eq('user_id', userId)
    .eq('completion_status', 'pending')
    .gte('due_date', overdueFloor)
    .lt('due_date', tomorrowStr)
    .order('due_date', { ascending: false })
    .limit(8)

  const courseNameMap: Record<string, string> = {}
  for (const c of courses) courseNameMap[c.course_id] = c.name

  let hwOrder = tasks.length + 1
  for (const a of assignments ?? []) {
    const isOverdue = a.due_date < today
    const daysOverdue = isOverdue ? daysBetweenDateKeys(a.due_date, today) : 0
    // Unified 0–100 urgency: due-today is high; overdue climbs with how late it is.
    const urgency = isOverdue ? clamp(64 + daysOverdue * 3, 64, 92) : 58
    const courseLabel = courseNameMap[a.course_id] ?? ''
    const reason = isOverdue
      ? `Overdue${daysOverdue > 0 ? ` by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}` : ''}${courseLabel ? ` · ${courseLabel}` : ''}`
      : `Due today${courseLabel ? ` · ${courseLabel}` : ''}`
    tasks.push({
      type: 'homework',
      course_id: a.course_id,
      course_name: courseLabel,
      assignment_id: a.assignment_id,
      title: prettifyTitle(a.name),
      due_date: a.due_date,
      overdue: isOverdue,
      priority_score: Math.round(urgency),
      reason,
      order: hwOrder++,
    })
  }

  if (tasks.length === 0) return

  // Unified ordering: sort ALL task types by their shared 0–100 urgency so an
  // exam-tomorrow quiz or an overdue assignment can sit at the very top, instead of
  // being permanently buried beneath flashcard reviews. Then renumber order.
  const taskUrgency = (t: TaskItem) => ('priority_score' in t ? t.priority_score ?? 0 : 0)
  tasks.sort((a, b) => taskUrgency(b) - taskUrgency(a))
  tasks.forEach((t, i) => { t.order = i + 1 })

  // Build insight
  const nextExamEntry = Object.entries(nextExamByCourse).sort((a, b) => a[1] - b[1])[0]
  const nextExam = nextExamEntry
    ? { courseName: courseNameMap[nextExamEntry[0]] ?? 'Unknown', daysAway: nextExamEntry[1] }
    : null
  const overallWeakest = scored
    .flatMap(c => c.weakest_topic ? [{ topicName: c.weakest_topic.name, courseName: c.course_name, mastery: c.weakest_topic.mastery }] : [])
    .sort((a, b) => a.mastery - b.mastery)[0] ?? null
  const totalDueCards = scored.reduce((sum, c) => sum + c.card_count, 0)
  const pendingHomework = (assignments ?? []).length

  // "Started" = has reviewed at least one card. Drives encouraging cold-start
  // framing instead of a misleading "your weakest area is X" on a fresh account.
  const { count: reviewedCount } = await service
    .from('flashcards')
    .select('card_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('fsrs_reps', 0)
  const hasStarted = (reviewedCount ?? 0) > 0

  const insightText = buildInsight({
    courses,
    nextExam,
    weakestTopic: overallWeakest,
    totalDueCards,
    pendingHomework,
    hasStarted,
  })

  const allTasks: TaskItem[] = [
    { type: 'insight', text: insightText, order: 0 },
    ...tasks,
  ]

  await service
    .from('study_plan')
    .upsert(
      { user_id: userId, plan_date: today, tasks: allTasks, generated_at: new Date().toISOString() },
      { onConflict: 'user_id,plan_date' }
    )

  // Write to Google Calendar if connected
  const calendarTasks = tasks.filter(t => t.type === 'flashcard_review') as Extract<TaskItem, { type: 'flashcard_review' }>[]
  writeStudyBlocksToCalendar(userId, calendarTasks).catch(e =>
    console.error('[scheduler] calendar write failed', e)
  )
}

// Generates lightweight preview plans for the next 6 days (only if not already cached)
export async function generateUpcomingPreview(userId: string): Promise<void> {
  const service = createServiceClient()

  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', userId)
    .single()
  const timeZone = userRow?.timezone ?? 'UTC'
  const today = dateKeyInTimeZone(new Date(), timeZone)

  const { data: courses } = await service
    .from('courses')
    .select('course_id, name')
    .eq('user_id', userId)
    .eq('active_status', 'active')

  if (!courses || courses.length === 0) return

  const courseNameMap: Record<string, string> = {}
  const courseIds: string[] = []
  for (const c of courses) {
    courseNameMap[c.course_id] = c.name
    courseIds.push(c.course_id)
  }

  // Build the 6-day window upfront.
  const dateStrs: string[] = []
  for (let dayOffset = 1; dayOffset <= 6; dayOffset++) {
    dateStrs.push(addDaysToDateKey(today, dayOffset))
  }
  const windowStart = dateStrs[0]
  const windowEndExclusive = addDaysToDateKey(today, 7)

  // Batch: existing plans + all due cards in window + all pending homework in window.
  const [existingPlansResult, dueCardsResult, assignmentsResult] = await Promise.all([
    service
      .from('study_plan')
      .select('plan_date')
      .eq('user_id', userId)
      .in('plan_date', dateStrs),
    service
      .from('flashcards')
      .select('card_id, topic_id, course_id, fsrs_next_review_date')
      .eq('user_id', userId)
      .in('course_id', courseIds)
      .in('fsrs_next_review_date', dateStrs),
    service
      .from('assignments')
      .select('assignment_id, name, due_date, course_id')
      .eq('user_id', userId)
      .eq('completion_status', 'pending')
      .gte('due_date', windowStart)
      .lt('due_date', windowEndExclusive),
  ])

  const existingPlanDates = new Set(
    ((existingPlansResult.data ?? []) as { plan_date: string }[]).map(p => p.plan_date)
  )

  // Group due cards by (date, course) via nested Map.
  const cardsByDateCourse = new Map<string, Map<string, { topic_id: string | null }[]>>()
  for (const c of (dueCardsResult.data ?? []) as { card_id: string; topic_id: string | null; course_id: string; fsrs_next_review_date: string }[]) {
    let byCourse = cardsByDateCourse.get(c.fsrs_next_review_date)
    if (!byCourse) { byCourse = new Map(); cardsByDateCourse.set(c.fsrs_next_review_date, byCourse) }
    const arr = byCourse.get(c.course_id) ?? []
    arr.push({ topic_id: c.topic_id })
    byCourse.set(c.course_id, arr)
  }

  const assignmentsByDate = new Map<string, { assignment_id: string; name: string; due_date: string; course_id: string }[]>()
  for (const a of (assignmentsResult.data ?? []) as { assignment_id: string; name: string; due_date: string; course_id: string }[]) {
    // due_date is a date-only value stored as UTC-midnight timestamptz (the picker
    // and inbox agent both write a bare YYYY-MM-DD). Group by its date portion so it
    // aligns with dateStrs (and with how due cards are binned by raw fsrs_next_review_date).
    // Re-zoning with dateKeyInTimeZone would shift the day for non-UTC users.
    const dueKey = a.due_date.split('T')[0]
    const arr = assignmentsByDate.get(dueKey) ?? []
    arr.push(a) // keep original a.due_date for display
    assignmentsByDate.set(dueKey, arr)
  }

  const rowsToInsert: { user_id: string; plan_date: string; tasks: TaskItem[]; generated_at: string }[] = []

  for (const dateStr of dateStrs) {
    if (existingPlanDates.has(dateStr)) continue

    const tasks: TaskItem[] = []
    let order = 1

    const byCourse = cardsByDateCourse.get(dateStr)
    if (byCourse) {
      for (const course of courses) {
        const dueCards = byCourse.get(course.course_id)
        if (!dueCards || dueCards.length === 0) continue
        const topicIds = [...new Set(dueCards.map(c => c.topic_id).filter(Boolean) as string[])]
        tasks.push({
          type: 'flashcard_review',
          course_id: course.course_id,
          course_name: course.name,
          topic_ids: topicIds,
          card_count: dueCards.length,
          duration_minutes: Math.max(5, Math.round(dueCards.length * 1.5)),
          priority_score: 0,
          order: order++,
        })
      }
    }

    for (const a of assignmentsByDate.get(dateStr) ?? []) {
      tasks.push({
        type: 'homework',
        course_id: a.course_id,
        course_name: courseNameMap[a.course_id] ?? '',
        assignment_id: a.assignment_id,
        title: prettifyTitle(a.name),
        due_date: a.due_date,
        overdue: false,
        order: order++,
      })
    }

    if (tasks.length === 0) continue

    rowsToInsert.push({
      user_id: userId,
      plan_date: dateStr,
      tasks,
      generated_at: new Date().toISOString(),
    })
  }

  if (rowsToInsert.length > 0) {
    // Upsert (ignore duplicates) so a race between this preview and a concurrent
    // run / the Today-page scheduler can't throw on the unique(user_id, plan_date)
    // constraint. Existing rows are left as-is.
    const { error } = await service
      .from('study_plan')
      .upsert(rowsToInsert, { onConflict: 'user_id,plan_date', ignoreDuplicates: true })
    if (error) console.error('[scheduler] generateUpcomingPreview upsert failed', error)
  }
}
