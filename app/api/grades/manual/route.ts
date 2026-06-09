import { createClient, createServiceClient } from '@/lib/supabase/server'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized, notFound } from '@/lib/api-error'
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

  const body = await request.json() as { courseId?: string; current_pct?: number; remaining_weight_pct?: number }
  if (!body.courseId) return badRequest('missing_courseId')
  if (typeof body.current_pct !== 'number' || body.current_pct < 0 || body.current_pct > 100) {
    return badRequest('invalid_current_pct')
  }
  const remaining = body.remaining_weight_pct ?? 0
  if (typeof remaining !== 'number' || remaining < 0 || remaining > 100) {
    return badRequest('invalid_remaining_weight_pct')
  }
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const service = createServiceClient()
  const { error } = await service.from('course_grade_manual').upsert({
    user_id: user.id,
    course_id: body.courseId,
    current_pct: Math.round(body.current_pct * 100) / 100,
    remaining_weight_pct: Math.round(remaining * 100) / 100,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,course_id' })
  if (error) return serverError('grades/manual PUT', error)
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const { courseId } = await request.json() as { courseId?: string }
  if (!courseId) return badRequest('missing_courseId')

  const service = createServiceClient()
  const { error } = await service.from('course_grade_manual').delete().eq('user_id', user.id).eq('course_id', courseId)
  if (error) return serverError('grades/manual DELETE', error)
  return NextResponse.json({ ok: true })
}
