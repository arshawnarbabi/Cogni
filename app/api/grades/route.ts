import { createClient, createServiceClient } from '@/lib/supabase/server'
import { computeGradeSummary, whatIfTargets, type SchemeCategory, type GradeItemInput } from '@/lib/grades'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized, notFound } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Grade tracker (S1).
//   GET    ?courseId=…             → scheme + items + computed summary + what-ifs
//   POST   {courseId, name, …}     → add a grade item
//   PATCH  {itemId, …}             → edit a grade item
//   PUT    {courseId, scheme: […]} → replace the grading scheme
//   DELETE {itemId}                → remove a grade item

async function authedUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const courseId = new URL(request.url).searchParams.get('courseId')
  if (!courseId) return badRequest('missing_courseId')
  if (!(await requireOwnedCourse(user.id, courseId))) return notFound('course_not_found')

  const service = createServiceClient()
  const [{ data: schemeRows }, { data: itemRows }] = await Promise.all([
    service.from('course_grade_schemes').select('category, weight_pct').eq('user_id', user.id).eq('course_id', courseId).order('weight_pct', { ascending: false }),
    service.from('grade_items').select('item_id, category, name, points_earned, points_possible, graded_at, source').eq('user_id', user.id).eq('course_id', courseId).order('graded_at', { ascending: false }),
  ])

  const scheme: SchemeCategory[] = ((schemeRows ?? []) as { category: string; weight_pct: number }[])
    .map(s => ({ category: s.category, weight_pct: Number(s.weight_pct) }))
  const items = (itemRows ?? []) as { item_id: string; category: string | null; name: string; points_earned: number | null; points_possible: number; graded_at: string; source: string }[]
  const itemInputs: GradeItemInput[] = items.map(i => ({
    category: i.category,
    points_earned: i.points_earned !== null ? Number(i.points_earned) : null,
    points_possible: Number(i.points_possible),
  }))

  return NextResponse.json({
    scheme,
    items,
    summary: computeGradeSummary(scheme, itemInputs),
    whatIf: whatIfTargets(scheme, itemInputs, [90, 80, 70]),
  })
}

export async function POST(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await request.json() as {
    courseId?: string; name?: string; category?: string | null
    points_earned?: number | null; points_possible?: number
  }
  if (!body.courseId || !body.name?.trim()) return badRequest('missing_fields')
  if (typeof body.points_possible !== 'number' || body.points_possible <= 0) return badRequest('invalid_points_possible')
  if (body.points_earned !== null && body.points_earned !== undefined && (typeof body.points_earned !== 'number' || body.points_earned < 0)) {
    return badRequest('invalid_points_earned')
  }
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const service = createServiceClient()
  const { data, error } = await service.from('grade_items').insert({
    user_id: user.id,
    course_id: body.courseId,
    name: body.name.trim().slice(0, 200),
    category: body.category?.trim().slice(0, 80) || null,
    points_earned: body.points_earned ?? null,
    points_possible: body.points_possible,
    source: 'manual',
  }).select('item_id').single()
  if (error) return serverError('grades POST', error)
  return NextResponse.json({ ok: true, item_id: data.item_id })
}

export async function PATCH(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await request.json() as {
    itemId?: string; name?: string; category?: string | null
    points_earned?: number | null; points_possible?: number
  }
  if (!body.itemId) return badRequest('missing_itemId')

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) return badRequest('invalid_name')
    updates.name = body.name.trim().slice(0, 200)
  }
  if (body.category !== undefined) updates.category = body.category?.trim().slice(0, 80) || null
  if (body.points_earned !== undefined) {
    if (body.points_earned !== null && (typeof body.points_earned !== 'number' || body.points_earned < 0)) return badRequest('invalid_points_earned')
    updates.points_earned = body.points_earned
  }
  if (body.points_possible !== undefined) {
    if (typeof body.points_possible !== 'number' || body.points_possible <= 0) return badRequest('invalid_points_possible')
    updates.points_possible = body.points_possible
  }
  if (Object.keys(updates).length === 0) return badRequest('no_updates')

  const service = createServiceClient()
  const { error } = await service.from('grade_items').update(updates).eq('item_id', body.itemId).eq('user_id', user.id)
  if (error) return serverError('grades PATCH', error)
  return NextResponse.json({ ok: true })
}

export async function PUT(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await request.json() as { courseId?: string; scheme?: { category?: string; weight_pct?: number }[] }
  if (!body.courseId || !Array.isArray(body.scheme)) return badRequest('missing_fields')
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const cleaned = body.scheme
    .filter(s => typeof s.category === 'string' && s.category.trim().length > 0 &&
      typeof s.weight_pct === 'number' && s.weight_pct > 0 && s.weight_pct <= 100)
    .map(s => ({ category: (s.category as string).trim().slice(0, 80), weight_pct: Math.round((s.weight_pct as number) * 100) / 100 }))
    .slice(0, 12)

  const service = createServiceClient()
  // Replace wholesale — the student edited the full scheme.
  const { error: delError } = await service.from('course_grade_schemes').delete().eq('user_id', user.id).eq('course_id', body.courseId)
  if (delError) return serverError('grades PUT delete', delError)
  if (cleaned.length > 0) {
    const { error: insError } = await service.from('course_grade_schemes').insert(
      cleaned.map(s => ({ user_id: user.id, course_id: body.courseId, ...s }))
    )
    if (insError) return serverError('grades PUT insert', insError)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const { itemId } = await request.json() as { itemId?: string }
  if (!itemId) return badRequest('missing_itemId')

  const service = createServiceClient()
  const { error } = await service.from('grade_items').delete().eq('item_id', itemId).eq('user_id', user.id)
  if (error) return serverError('grades DELETE', error)
  return NextResponse.json({ ok: true })
}
