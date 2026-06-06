import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserKey } from '@/lib/user-keys'
import { listCanvasCourses, getCourseGradeData, mapCanvasCourseData, CanvasAuthError } from '@/lib/canvas'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
// Multiple paginated Canvas calls, serialized per course.
export const maxDuration = 300

// Canvas import/sync (S5).
//   POST { mappings: [{ canvasCourseId, cogniCourseId }] } → link + import
//   POST { sync: true }                                    → re-import all linked courses
//
// Per course: grading scheme (when Canvas weights groups), graded submissions →
// grade_items (upsert on external_id — re-syncs update, never duplicate), and
// future-dated assignments → the planner (deduped by the B12 unique index).

type ImportStats = { course: string; gradeItems: number; assignments: number; schemeCategories: number }

async function importOneCourse(
  userId: string,
  baseUrl: string,
  token: string,
  canvasCourseId: string,
  cogniCourseId: string,
  applyWeights: boolean,
  courseName: string,
): Promise<ImportStats> {
  const service = createServiceClient()
  const groups = await getCourseGradeData(baseUrl, token, canvasCourseId)
  const mapped = mapCanvasCourseData(groups, applyWeights, new Date().toISOString())

  // Grading scheme: Canvas's weighted groups are authoritative when present —
  // upsert refreshes weights; categories the syllabus-profiler guessed stay
  // unless Canvas names the same category.
  if (mapped.scheme.length > 0) {
    const { error } = await service.from('course_grade_schemes').upsert(
      mapped.scheme.map(s => ({ user_id: userId, course_id: cogniCourseId, ...s })),
      { onConflict: 'user_id,course_id,category' },
    )
    if (error) console.error('[canvas] scheme upsert failed', error)
  }

  // Graded work → grade_items (exactly-once per Canvas assignment).
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
    if (error) console.error('[canvas] grade items upsert failed', error)
  }

  // Future-dated assignments → planner (the B12 unique index dedupes).
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
    if (error) console.error('[canvas] assignments upsert failed', error)
  }

  return {
    course: courseName,
    gradeItems: mapped.gradeItems.length,
    assignments: mapped.upcomingAssignments.length,
    schemeCategories: mapped.scheme.length,
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const body = await request.json() as {
    mappings?: { canvasCourseId?: string; cogniCourseId?: string }[]
    sync?: boolean
  }

  const service = createServiceClient()
  const [{ data: conn }, token] = await Promise.all([
    service.from('lms_connections').select('base_url').eq('user_id', user.id).maybeSingle(),
    getUserKey(user.id, 'canvas_token'),
  ])
  if (!conn || !token) return badRequest('not_connected')

  // The course list provides apply_assignment_group_weights per course.
  let canvasCourses
  try {
    canvasCourses = await listCanvasCourses(conn.base_url, token)
  } catch (e) {
    if (e instanceof CanvasAuthError) return NextResponse.json({ error: 'token_invalid' }, { status: 401 })
    return serverError('canvas import: course list', e)
  }
  const canvasById = new Map(canvasCourses.map(c => [String(c.id), c]))

  // Resolve which (canvas → cogni) pairs to process.
  let pairs: { canvasCourseId: string; cogniCourseId: string }[] = []
  if (body.sync === true) {
    const { data: linked } = await service
      .from('courses').select('course_id, lms_course_id')
      .eq('user_id', user.id).not('lms_course_id', 'is', null)
    pairs = ((linked ?? []) as { course_id: string; lms_course_id: string }[])
      .map(c => ({ canvasCourseId: c.lms_course_id, cogniCourseId: c.course_id }))
  } else if (Array.isArray(body.mappings)) {
    for (const m of body.mappings.slice(0, 12)) {
      if (!m.canvasCourseId || !m.cogniCourseId) continue
      if (!canvasById.has(m.canvasCourseId)) continue
      if (!(await requireOwnedCourse(user.id, m.cogniCourseId))) continue
      pairs.push({ canvasCourseId: m.canvasCourseId, cogniCourseId: m.cogniCourseId })
      // Persist the link for future syncs.
      await service.from('courses').update({ lms_course_id: m.canvasCourseId }).eq('course_id', m.cogniCourseId).eq('user_id', user.id)
    }
  }
  if (pairs.length === 0) return badRequest('nothing_to_import')

  // SERIALIZED per Canvas's throttling guidance (one in-flight request per token).
  const results: ImportStats[] = []
  const skipped: string[] = []
  for (const pair of pairs) {
    const canvasCourse = canvasById.get(pair.canvasCourseId)
    if (!canvasCourse) { skipped.push(pair.canvasCourseId); continue }
    try {
      results.push(await importOneCourse(
        user.id, conn.base_url, token,
        pair.canvasCourseId, pair.cogniCourseId,
        canvasCourse.apply_assignment_group_weights === true,
        canvasCourse.name ?? `Course ${pair.canvasCourseId}`,
      ))
    } catch (e) {
      // Per-course 404s (date-restricted/unpublished) skip, not fail-all.
      console.error(`[canvas] import failed for ${pair.canvasCourseId}`, e)
      skipped.push(canvasCourse.name ?? pair.canvasCourseId)
    }
  }

  await service.from('lms_connections').update({ last_synced_at: new Date().toISOString() }).eq('user_id', user.id)

  return NextResponse.json({ ok: true, results, skipped })
}
