import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { runScheduler, generateUpcomingPreview } from '@/lib/agents/scheduler'
import { runNudgeChecks, getTopNudge } from '@/lib/agents/nudge'
import { getUserApiKey } from '@/lib/vault'
import { TodayClient } from './_client'
import { addDaysToDateKey, dateKeyInTimeZone } from '@/lib/time'
import type { TaskItem } from '@/lib/agents/scheduler'
import type { ActiveNudge } from '@/lib/agents/nudge'

export const dynamic = 'force-dynamic'

function greeting(name: string) {
  const h = new Date().getHours()
  const time = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  return `Good ${time}, ${name}`
}

export default async function TodayPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()

  const [
    { data: userRow },
    { data: plan },
    { data: inboxPending },
    apiKey,
    { data: courses },
  ] = await Promise.all([
    service.from('users').select('display_name, study_streak, last_study_date, timezone').eq('user_id', user.id).single(),
    service.from('study_plan').select('tasks').eq('user_id', user.id).eq('plan_date', dateKeyInTimeZone(new Date(), 'UTC')).single(),
    service.from('inbox_items').select('inbox_item_id').eq('user_id', user.id).in('classification_status', ['pending', 'unassigned']),
    getUserApiKey(user.id),
    service.from('courses').select('course_id, name, icon, icon_color').eq('user_id', user.id).eq('active_status', 'active'),
  ])

  const timeZone = userRow?.timezone ?? 'UTC'
  const today = dateKeyInTimeZone(new Date(), timeZone)
  let planData = plan
  if (timeZone !== 'UTC') {
    const { data: localPlan } = await service
      .from('study_plan')
      .select('tasks')
      .eq('user_id', user.id)
      .eq('plan_date', today)
      .single()
    planData = localPlan
  }

  // Detect active courses missing a syllabus (no Tier 1 material)
  const courseIds = (courses ?? []).map((c: { course_id: string }) => c.course_id)
  const { data: tier1Materials } = courseIds.length > 0
    ? await service.from('materials').select('course_id').eq('user_id', user.id).eq('tier', 1).in('course_id', courseIds)
    : { data: [] as { course_id: string }[] }

  const coursesWithSyllabus = new Set((tier1Materials ?? []).map((m: { course_id: string }) => m.course_id))
  const missingSyllabus = (courses ?? []).filter(
    (c: { course_id: string; name: string }) => !coursesWithSyllabus.has(c.course_id)
  ) as { course_id: string; name: string }[]

  // Run nudge checks and fetch top nudge
  await runNudgeChecks(user.id)
  const activeNudge: ActiveNudge | null = await getTopNudge(user.id)

  // Auto-generate today's plan if none exists
  let tasks: TaskItem[] = []
  if (!planData) {
    await runScheduler(user.id)
    const { data: fresh } = await service
      .from('study_plan')
      .select('tasks')
      .eq('user_id', user.id)
      .eq('plan_date', today)
      .single()
    tasks = (fresh?.tasks as TaskItem[]) ?? []
  } else {
    tasks = (planData.tasks as TaskItem[]) ?? []
  }

  // Enrich homework tasks with their live completion status from the assignments table
  type HwTask = Extract<TaskItem, { type: 'homework' }>
  const hwTaskIds = tasks
    .filter((t): t is HwTask => t.type === 'homework')
    .map(t => t.assignment_id)
  if (hwTaskIds.length > 0) {
    const { data: assignmentRows } = await service
      .from('assignments')
      .select('assignment_id, completion_status')
      .eq('user_id', user.id)
      .in('assignment_id', hwTaskIds)
    const statusMap = new Map<string, 'pending' | 'complete' | 'late'>(
      (assignmentRows ?? []).map((a: { assignment_id: string; completion_status: 'pending' | 'complete' | 'late' }) => [a.assignment_id, a.completion_status])
    )
    tasks = tasks.map((t): TaskItem => {
      if (t.type !== 'homework') return t
      const status = statusMap.get(t.assignment_id)
      return status ? { ...t, completion_status: status } : t
    })
  }

  // Enrich flashcard_review tasks with their live due-card counts. The stored plan
  // freezes card_count at generation time, so after a review session the page would
  // otherwise keep showing the old "N cards due" number and the task wouldn't reflect
  // progress on refresh.
  type FcTask = Extract<TaskItem, { type: 'flashcard_review' }>
  const fcCourseIds = tasks
    .filter((t): t is FcTask => t.type === 'flashcard_review')
    .map(t => t.course_id)
  if (fcCourseIds.length > 0) {
    const { data: liveDue } = await service
      .from('flashcards')
      .select('course_id')
      .eq('user_id', user.id)
      .in('course_id', fcCourseIds)
      .lte('fsrs_next_review_date', today)
    const liveCountByCourse = new Map<string, number>()
    for (const row of (liveDue ?? []) as { course_id: string }[]) {
      liveCountByCourse.set(row.course_id, (liveCountByCourse.get(row.course_id) ?? 0) + 1)
    }
    tasks = tasks.map((t): TaskItem => {
      if (t.type !== 'flashcard_review') return t
      return { ...t, card_count: liveCountByCourse.get(t.course_id) ?? 0 }
    })
  }

  // Fire-and-forget: generate upcoming 6-day preview (skips days already cached)
  generateUpcomingPreview(user.id).catch(() => {})

  // Fetch next 6 days' plans for the weekly schedule section
  const upcomingDates = Array.from({ length: 6 }, (_, i) => {
    return addDaysToDateKey(today, i + 1)
  })

  const { data: upcomingPlans } = await service
    .from('study_plan')
    .select('plan_date, tasks')
    .eq('user_id', user.id)
    .in('plan_date', upcomingDates)
    .order('plan_date', { ascending: true })

  const upcomingSchedule = (upcomingPlans ?? []).map((p: { plan_date: string; tasks: TaskItem[] }) => ({
    date: p.plan_date,
    tasks: p.tasks as TaskItem[],
  }))

  const courseIconMap: Record<string, { icon: string | null; icon_color: string | null }> = {}
  for (const c of (courses ?? []) as { course_id: string; icon: string | null; icon_color: string | null }[]) {
    courseIconMap[c.course_id] = { icon: c.icon, icon_color: c.icon_color }
  }

  return (
    <TodayClient
      greeting={greeting(userRow?.display_name ?? 'there')}
      tasks={tasks}
      upcomingSchedule={upcomingSchedule}
      pendingCount={inboxPending?.length ?? 0}
      streak={userRow?.study_streak ?? 0}
      hasApiKey={!!apiKey}
      missingSyllabus={missingSyllabus}
      activeNudge={activeNudge}
      courseIconMap={courseIconMap}
    />
  )
}
