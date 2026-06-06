import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserKey } from '@/lib/user-keys'
import { listCanvasCourses, CanvasAuthError } from '@/lib/canvas'
import { importCanvasCourse, syncLinkedCanvasCourses, type CourseSyncStats } from '@/lib/lms-sync'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
// Multiple paginated Canvas calls, serialized per course.
export const maxDuration = 300

// Canvas import/sync (S5).
//   POST { mappings: [{ canvasCourseId, cogniCourseId }] } → link + import
//   POST { sync: true }                                    → re-import all linked courses
// (The daily scheduler cron also runs syncLinkedCanvasCourses automatically —
// this endpoint is the on-demand path.)

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const body = await request.json() as {
    mappings?: { canvasCourseId?: string; cogniCourseId?: string }[]
    sync?: boolean
  }

  // On-demand re-sync of already-linked courses: shared lib (same code the cron runs).
  if (body.sync === true) {
    const synced = await syncLinkedCanvasCourses(user.id)
    if (!synced) return badRequest('nothing_to_import')
    if (synced.tokenInvalid) return NextResponse.json({ error: 'token_invalid' }, { status: 401 })
    return NextResponse.json({ ok: true, results: synced.results, skipped: synced.skipped })
  }

  if (!Array.isArray(body.mappings)) return badRequest('nothing_to_import')

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

  const pairs: { canvasCourseId: string; cogniCourseId: string }[] = []
  for (const m of body.mappings.slice(0, 12)) {
    if (!m.canvasCourseId || !m.cogniCourseId) continue
    if (!canvasById.has(m.canvasCourseId)) continue
    if (!(await requireOwnedCourse(user.id, m.cogniCourseId))) continue
    pairs.push({ canvasCourseId: m.canvasCourseId, cogniCourseId: m.cogniCourseId })
    // Persist the link for future syncs (incl. the automatic daily one).
    await service.from('courses').update({ lms_course_id: m.canvasCourseId }).eq('course_id', m.cogniCourseId).eq('user_id', user.id)
  }
  if (pairs.length === 0) return badRequest('nothing_to_import')

  // SERIALIZED per Canvas's throttling guidance (one in-flight request per token).
  const results: CourseSyncStats[] = []
  const skipped: string[] = []
  for (const pair of pairs) {
    const canvasCourse = canvasById.get(pair.canvasCourseId)
    if (!canvasCourse) { skipped.push(pair.canvasCourseId); continue }
    try {
      results.push(await importCanvasCourse(
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
