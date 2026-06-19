import { createClient, createServiceClient } from '@/lib/supabase/server'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized, notFound, readJson, finiteNumber } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Direct class-grade input (F2) — the no-tracking fallback. A course in "manual"
// mode stores one row: the current grade + how much weight is still ungraded
// (so "what do I need on the final" still works). The grade math, the risk
// signal, the scheduler, and semester standing all read this override.
//   PUT    { courseId, current_pct, remaining_weight_pct? }  → switch to manual + upsert
//   DELETE { courseId }                                       → back to item-tracking

async function authedUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function PUT(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{ courseId?: string; current_pct?: number; remaining_weight_pct?: number }>(request)
  if (!body) return badRequest('invalid_json')
  if (!body.courseId) return badRequest('missing_courseId')
  // finiteNumber also rejects NaN, which `typeof === 'number'` + range checks
  // let through (NaN < 0 and NaN > 100 are both false).
  const current = finiteNumber(body.current_pct, { min: 0, max: 100 })
  if (current === null) return badRequest('invalid_current_pct')
  const remaining = body.remaining_weight_pct === undefined ? 0 : finiteNumber(body.remaining_weight_pct, { min: 0, max: 100 })
  if (remaining === null) return badRequest('invalid_remaining_weight_pct')
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const service = createServiceClient()
  const { error } = await service.from('course_grade_manual').upsert({
    user_id: user.id,
    course_id: body.courseId,
    current_pct: Math.round(current * 100) / 100,
    remaining_weight_pct: Math.round(remaining * 100) / 100,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,course_id' })
  if (error) return serverError('grades/manual PUT', error)
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{ courseId?: string }>(request)
  if (!body) return badRequest('invalid_json')
  const { courseId } = body
  if (!courseId) return badRequest('missing_courseId')

  const service = createServiceClient()
  const { error } = await service.from('course_grade_manual').delete().eq('user_id', user.id).eq('course_id', courseId)
  if (error) return serverError('grades/manual DELETE', error)
  return NextResponse.json({ ok: true })
}
