import { createServiceClient } from '@/lib/supabase/server'
import { addDaysToDateKey, dateKeyInTimeZone } from '@/lib/time'

export type ActiveNudge = {
  nudge_id: string
  type: string
  tier: 'critical' | 'standard' | 'recurring'
  content: string
  course_id: string | null
}

function dedupKey(type: string, course_id: string | null): string {
  return `${type}:${course_id ?? ''}`
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
}

export async function runNudgeChecks(userId: string): Promise<void> {
  const service = createServiceClient()
  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', userId)
    .single()
  const today = dateKeyInTimeZone(new Date(), userRow?.timezone ?? 'UTC')
  const in21Days = addDaysToDateKey(today, 21)

  const { data: courses } = await service
    .from('courses')
    .select('course_id, name, created_at')
    .eq('user_id', userId)
    .eq('active_status', 'active')

  if (!courses || courses.length === 0) return

  const courseIds = courses.map((c: { course_id: string }) => c.course_id)
  const courseNameMap: Record<string, string> = {}
  for (const c of courses) courseNameMap[c.course_id] = c.name

  const [
    { data: allMaterials },
    { data: overdueAssignments },
    { data: upcomingExams },
    { data: existingNudges },
  ] = await Promise.all([
    service.from('materials').select('course_id, tier').eq('user_id', userId).in('course_id', courseIds),
    service.from('assignments').select('assignment_id, course_id, name')
      .eq('user_id', userId).eq('completion_status', 'pending').lt('due_date', today),
    service.from('exams').select('course_id, date')
      .eq('user_id', userId).gte('date', today).lte('date', in21Days),
    service.from('nudges').select('nudge_id, type, course_id, status, snoozed_until')
      .eq('user_id', userId).in('status', ['pending', 'snoozed']),
  ])

  const hasTier1 = new Set<string>()
  const hasTier2Plus = new Set<string>()
  for (const m of allMaterials ?? []) {
    if (m.tier === 1) hasTier1.add(m.course_id)
    if (m.tier >= 2) hasTier2Plus.add(m.course_id)
  }

  const nextExamDateByCourse: Record<string, string> = {}
  for (const e of upcomingExams ?? []) {
    if (!(e.course_id in nextExamDateByCourse) || e.date < nextExamDateByCourse[e.course_id]) {
      nextExamDateByCourse[e.course_id] = e.date
    }
  }

  const existingByKey = new Map<string, { nudge_id: string; status: string; snoozed_until: string | null }>()
  for (const n of existingNudges ?? []) {
    existingByKey.set(dedupKey(n.type, n.course_id), {
      nudge_id: n.nudge_id,
      status: n.status,
      snoozed_until: n.snoozed_until,
    })
  }

  type NudgeSpec = { type: string; tier: 'critical' | 'standard' | 'recurring'; content: string; course_id: string | null }
  const specs: NudgeSpec[] = []

  // Overdue homework — one nudge per course (recurring)
  const overdueByCourseName: Record<string, string[]> = {}
  for (const a of overdueAssignments ?? []) {
    const name = courseNameMap[a.course_id]
    if (!name) continue
    if (!overdueByCourseName[a.course_id]) overdueByCourseName[a.course_id] = []
    overdueByCourseName[a.course_id].push(a.name ?? 'assignment')
  }
  for (const [courseId, names] of Object.entries(overdueByCourseName)) {
    const content = names.length === 1
      ? `"${names[0]}" is overdue for ${courseNameMap[courseId]}`
      : `${names.length} assignments are overdue for ${courseNameMap[courseId]}`
    specs.push({ type: 'homework_completion', tier: 'recurring', content, course_id: courseId })
  }

  // Per-course material checks
  for (const course of courses) {
    const examDate = nextExamDateByCourse[course.course_id]
    const daysToExam = examDate ? daysUntil(examDate) : null
    const hasT1 = hasTier1.has(course.course_id)
    const hasT2 = hasTier2Plus.has(course.course_id)

    // Material gap: has syllabus, no Tier 2+, exam within 21 days (standard)
    if (hasT1 && !hasT2 && daysToExam !== null && daysToExam <= 21) {
      specs.push({
        type: 'material_gap',
        tier: 'standard',
        content: `Exam in ${daysToExam} day${daysToExam === 1 ? '' : 's'} — add lecture notes or slides for ${course.name} to build flashcards`,
        course_id: course.course_id,
      })
      continue
    }

    // Syllabus-only: has syllabus, no Tier 2+, no immediate exam, course >3 days old (standard)
    const courseAgeDays = Math.floor((Date.now() - new Date(course.created_at).getTime()) / 86400000)
    if (hasT1 && !hasT2 && courseAgeDays >= 3) {
      specs.push({
        type: 'upload_content',
        tier: 'standard',
        content: `${course.name} only has a syllabus — upload lecture notes or slides to generate flashcards`,
        course_id: course.course_id,
      })
    }
  }

  // Auto-resolve pending nudges whose conditions no longer apply
  const validKeys = new Set(specs.map(s => dedupKey(s.type, s.course_id)))
  const toResolve = [...existingByKey.entries()]
    .filter(([key, n]) => !validKeys.has(key) && n.status === 'pending')
    .map(([, n]) => n.nudge_id)

  if (toResolve.length > 0) {
    await service.from('nudges')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .in('nudge_id', toResolve)
      .eq('user_id', userId)
  }

  // Upsert active nudges
  for (const spec of specs) {
    const key = dedupKey(spec.type, spec.course_id)
    const existing = existingByKey.get(key)

    if (!existing) {
      await service.from('nudges').insert({
        user_id: userId,
        type: spec.type,
        tier: spec.tier,
        content: spec.content,
        course_id: spec.course_id,
        status: 'pending',
      })
    } else if (existing.status === 'pending') {
      await service.from('nudges').update({ content: spec.content }).eq('nudge_id', existing.nudge_id).eq('user_id', userId)
    } else if (existing.status === 'snoozed') {
      const snoozedUntil = existing.snoozed_until ? new Date(existing.snoozed_until).getTime() : 0
      if (snoozedUntil <= Date.now()) {
        await service.from('nudges')
          .update({ status: 'pending', content: spec.content, snoozed_until: null })
          .eq('nudge_id', existing.nudge_id)
          .eq('user_id', userId)
      } else {
        await service.from('nudges').update({ content: spec.content }).eq('nudge_id', existing.nudge_id).eq('user_id', userId)
      }
    }
  }
}

export async function getTopNudge(userId: string): Promise<ActiveNudge | null> {
  const service = createServiceClient()

  const { data: nudges } = await service
    .from('nudges')
    .select('nudge_id, type, tier, content, course_id, status, snoozed_until')
    .eq('user_id', userId)
    .in('status', ['pending', 'snoozed'])
    .order('created_at', { ascending: false })

  if (!nudges || nudges.length === 0) return null

  const now = Date.now()
  const active = nudges.filter(
    (n: { status: string; snoozed_until: string | null }) =>
      n.status === 'pending' ||
      (n.status === 'snoozed' && n.snoozed_until != null && new Date(n.snoozed_until).getTime() <= now)
  )

  if (active.length === 0) return null

  const tierOrder: Record<string, number> = { critical: 0, recurring: 1, standard: 2 }
  active.sort((a: { tier: string }, b: { tier: string }) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3))

  const top = active[0]
  return {
    nudge_id: top.nudge_id,
    type: top.type,
    tier: top.tier as 'critical' | 'standard' | 'recurring',
    content: top.content,
    course_id: top.course_id,
  }
}
