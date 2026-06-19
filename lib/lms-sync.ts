import { createServiceClient } from '@/lib/supabase/server'
import { getUserKey } from '@/lib/user-keys'
import { listCanvasCourses, getCourseGradeData, mapCanvasCourseData, CanvasAuthError } from '@/lib/canvas'

// ─────────────────────────────────────────────────────────────────────────────
// Canvas sync (S5) — shared by the import route (on-demand) and the daily
// scheduler cron (automatic): released grades, the weighted grading scheme,
// and still-to-do future assignments for every LINKED course. Requests are
// serialized per token (Canvas throttling guidance).
// ─────────────────────────────────────────────────────────────────────────────

export type CourseSyncStats = { course: string; gradeItems: number; assignments: number; schemeCategories: number; errors?: string[] }
export type SyncResult = { results: CourseSyncStats[]; skipped: string[]; tokenInvalid?: boolean }

export async function importCanvasCourse(
  userId: string,
  baseUrl: string,
  token: string,
  canvasCourseId: string,
  cogniCourseId: string,
  applyWeights: boolean,
  courseName: string,
): Promise<CourseSyncStats> {
  const service = createServiceClient()
  const groups = await getCourseGradeData(baseUrl, token, canvasCourseId)
  const mapped = mapCanvasCourseData(groups, applyWeights, new Date().toISOString())

  // A failed upsert must NOT report its rows as synced — stats count successes
  // only, and the error is surfaced so the import route / cron can see it.
  const errors: string[] = []
  let schemeCount = 0
  let gradeCount = 0
  let assignmentCount = 0

  // Grading scheme: Canvas's weighted groups are authoritative when present.
  if (mapped.scheme.length > 0) {
    const { error } = await service.from('course_grade_schemes').upsert(
      mapped.scheme.map(s => ({ user_id: userId, course_id: cogniCourseId, ...s })),
      { onConflict: 'user_id,course_id,category' },
    )
    if (error) {
      console.error('[canvas] scheme upsert failed', error)
      errors.push(`scheme: ${error.message}`)
    } else {
      schemeCount = mapped.scheme.length
    }
  }

  // Released grades → grade_items (exactly-once per Canvas assignment).
  if (mapped.gradeItems.length > 0) {
    const { error } = await service.from('grade_items').upsert(
      mapped.gradeItems.map(g => ({
        user_id: userId,
        course_id: cogniCourseId,
        category: g.category,
        name: g.name,
        points_earned: g.points_earned,
        points_possible: g.points_possible,
        graded_at: g.graded_at ?? new Date().toISOString(),
        source: 'canvas',
        external_id: g.external_id,
      })),
      { onConflict: 'user_id,course_id,external_id' },
    )
    if (error) {
      console.error('[canvas] grade items upsert failed', error)
      errors.push(`grades: ${error.message}`)
    } else {
      gradeCount = mapped.gradeItems.length
    }
  }

  // Still-to-do future assignments → planner (B12 unique index dedupes).
  if (mapped.upcomingAssignments.length > 0) {
    const { error } = await service.from('assignments').upsert(
      mapped.upcomingAssignments.map(a => ({
        user_id: userId,
        course_id: cogniCourseId,
        name: a.name,
        due_date: a.due_date,
        type: 'homework',
        completion_status: 'pending',
      })),
      { onConflict: 'user_id,course_id,name,due_date', ignoreDuplicates: true },
    )
    if (error) {
      console.error('[canvas] assignments upsert failed', error)
      errors.push(`assignments: ${error.message}`)
    } else {
      assignmentCount = mapped.upcomingAssignments.length
    }
  }

  return {
    course: courseName,
    gradeItems: gradeCount,
    assignments: assignmentCount,
    schemeCategories: schemeCount,
    ...(errors.length > 0 ? { errors } : {}),
  }
}

/**
 * Re-sync every linked course for a user. Returns null when the user has no
 * Canvas connection or no linked courses (the cron's fast path — one cheap
 * query for most users). Never throws: per-course failures skip; an invalid
 * token is reported, not raised.
 */
export async function syncLinkedCanvasCourses(userId: string): Promise<SyncResult | null> {
  const service = createServiceClient()

  const { data: conn } = await service
    .from('lms_connections').select('base_url')
    .eq('user_id', userId).maybeSingle()
  if (!conn) return null

  const [token, { data: linked }] = await Promise.all([
    getUserKey(userId, 'canvas_token'),
    service.from('courses').select('course_id, lms_course_id').eq('user_id', userId).not('lms_course_id', 'is', null),
  ])
  const pairs = ((linked ?? []) as { course_id: string; lms_course_id: string }[])
  if (!token || pairs.length === 0) return null

  let canvasCourses
  try {
    canvasCourses = await listCanvasCourses(conn.base_url, token)
  } catch (e) {
    if (e instanceof CanvasAuthError) return { results: [], skipped: [], tokenInvalid: true }
    console.error('[canvas] sync course list failed', e)
    return { results: [], skipped: pairs.map(p => p.lms_course_id) }
  }
  const canvasById = new Map(canvasCourses.map(c => [String(c.id), c]))

  const results: CourseSyncStats[] = []
  const skipped: string[] = []
  // SERIALIZED per Canvas throttling guidance — one in-flight request per token.
  for (const pair of pairs) {
    const canvasCourse = canvasById.get(pair.lms_course_id)
    if (!canvasCourse) { skipped.push(pair.lms_course_id); continue }
    try {
      results.push(await importCanvasCourse(
        userId, conn.base_url, token,
        pair.lms_course_id, pair.course_id,
        canvasCourse.apply_assignment_group_weights === true,
        canvasCourse.name ?? `Course ${pair.lms_course_id}`,
      ))
    } catch (e) {
      console.error(`[canvas] sync failed for ${pair.lms_course_id}`, e)
      skipped.push(canvasCourse.name ?? pair.lms_course_id)
    }
  }

  await service.from('lms_connections').update({ last_synced_at: new Date().toISOString() }).eq('user_id', userId)
  return { results, skipped }
}
