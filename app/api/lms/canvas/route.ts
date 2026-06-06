import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserKey, setUserKey, deleteUserKey } from '@/lib/user-keys'
import { normalizeBaseUrl, listCanvasCourses, CanvasAuthError } from '@/lib/canvas'
import { serverError, badRequest, unauthorized } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Canvas connection management (S5). The access token lives ONLY in the Vault
// (user_keys secret 'canvas_token'), never in a table column.
//   GET    → connection status + the student's Canvas courses (when connected)
//   POST   {baseUrl, token} → validate against Canvas, then store
//   DELETE → disconnect (removes connection row + Vault secret)

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const service = createServiceClient()
  const [{ data: conn }, token, { data: cogniCourses }] = await Promise.all([
    service.from('lms_connections').select('base_url, last_synced_at').eq('user_id', user.id).maybeSingle(),
    getUserKey(user.id, 'canvas_token'),
    service.from('courses').select('course_id, name, lms_course_id').eq('user_id', user.id).eq('active_status', 'active'),
  ])

  if (!conn || !token) {
    return NextResponse.json({ connected: false, cogniCourses: cogniCourses ?? [] })
  }

  // Live course list for the mapping UI. An invalid token degrades to a
  // reconnect prompt instead of a 500.
  try {
    const canvasCourses = await listCanvasCourses(conn.base_url, token)
    return NextResponse.json({
      connected: true,
      baseUrl: conn.base_url,
      lastSyncedAt: conn.last_synced_at,
      cogniCourses: cogniCourses ?? [],
      canvasCourses: canvasCourses.map(c => ({
        id: String(c.id),
        name: c.name ?? c.course_code ?? `Course ${c.id}`,
        term: c.term?.name ?? null,
        current_score: c.enrollments?.find(e => e.type === 'student' || e.type === 'StudentEnrollment')?.computed_current_score ?? null,
      })),
    })
  } catch (e) {
    if (e instanceof CanvasAuthError) {
      return NextResponse.json({ connected: true, tokenInvalid: true, baseUrl: conn.base_url, cogniCourses: cogniCourses ?? [] })
    }
    console.error('[canvas] course list failed', e)
    return NextResponse.json({ connected: true, baseUrl: conn.base_url, fetchError: true, cogniCourses: cogniCourses ?? [] })
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const { baseUrl: rawUrl, token } = await request.json() as { baseUrl?: string; token?: string }
  const baseUrl = normalizeBaseUrl(rawUrl ?? '')
  if (!baseUrl) return badRequest('invalid_base_url')
  if (!token || token.trim().length < 16) return badRequest('invalid_token')

  // Validate BEFORE storing: one real call (also proves the base URL is right).
  try {
    await listCanvasCourses(baseUrl, token.trim())
  } catch (e) {
    if (e instanceof CanvasAuthError) {
      return NextResponse.json({ error: 'Canvas rejected that token. Generate a new one under Account → Settings → New Access Token, and check the URL is your school\'s Canvas.' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Could not reach that Canvas URL. Check it matches your school\'s Canvas address (e.g. school.instructure.com).' }, { status: 400 })
  }

  try {
    await setUserKey(user.id, 'canvas_token', token.trim())
  } catch (e) {
    return serverError('canvas POST vault', e)
  }
  const service = createServiceClient()
  const { error } = await service.from('lms_connections').upsert(
    { user_id: user.id, provider: 'canvas', base_url: baseUrl },
    { onConflict: 'user_id' },
  )
  if (error) return serverError('canvas POST upsert', error)

  return NextResponse.json({ ok: true })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const service = createServiceClient()
  await Promise.all([
    service.from('lms_connections').delete().eq('user_id', user.id),
    deleteUserKey(user.id, 'canvas_token').catch(() => {}),
  ])
  return NextResponse.json({ ok: true })
}
