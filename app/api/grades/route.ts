import { createClient, createServiceClient } from '@/lib/supabase/server'
import { computeGradeSummary, whatIfTargets, type SchemeCategory, type GradeItemInput } from '@/lib/grades'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError, badRequest, unauthorized, notFound, readJson, finiteNumber } from '@/lib/api-error'
import { NextResponse } from 'next/server'

// points columns are numeric(8,2) — anything bigger overflows into a 500.
const MAX_POINTS = 999_999

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
  const [{ data: schemeRows }, { data: itemRows }, { data: manualRow }] = await Promise.all([
    service.from('course_grade_schemes').select('category, weight_pct').eq('user_id', user.id).eq('course_id', courseId).order('weight_pct', { ascending: false }),
    service.from('grade_items').select('item_id, category, name, points_earned, points_possible, graded_at, source, confirmed').eq('user_id', user.id).eq('course_id', courseId).order('graded_at', { ascending: false }),
    service.from('course_grade_manual').select('current_pct, remaining_weight_pct').eq('user_id', user.id).eq('course_id', courseId).maybeSingle(),
  ])

  // F2: a course in "manual" mode uses the typed override for the grade + what-if.
  const override = manualRow
    ? { current_pct: Number(manualRow.current_pct), remaining_weight_pct: Number(manualRow.remaining_weight_pct) }
    : null

  const scheme: SchemeCategory[] = ((schemeRows ?? []) as { category: string; weight_pct: number }[])
    .map(s => ({ category: s.category, weight_pct: Number(s.weight_pct) }))
  const allItems = (itemRows ?? []) as { item_id: string; category: string | null; name: string; points_earned: number | null; points_possible: number; graded_at: string; source: string; confirmed: boolean }[]
  // F1: only CONFIRMED items count toward the grade + what-if. Unconfirmed
  // (upload-extracted) items are pending suggestions surfaced separately so a
  // vision misread can never silently move the grade.
  const items = allItems.filter(i => i.confirmed)
  const pending = allItems.filter(i => !i.confirmed)
  const itemInputs: GradeItemInput[] = items.map(i => ({
    category: i.category,
    points_earned: i.points_earned !== null ? Number(i.points_earned) : null,
    points_possible: Number(i.points_possible),
  }))

  return NextResponse.json({
    scheme,
    items,
    pending,
    mode: override ? 'manual' : 'tracked',
    override,
    summary: computeGradeSummary(scheme, itemInputs, override),
    whatIf: whatIfTargets(scheme, itemInputs, [90, 80, 70], override),
  })
}

export async function POST(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{
    courseId?: string; name?: string; category?: string | null
    points_earned?: number | null; points_possible?: number
  }>(request)
  if (!body) return badRequest('invalid_json')
  if (!body.courseId || typeof body.name !== 'string' || !body.name.trim()) return badRequest('missing_fields')
  // finiteNumber rejects NaN/Infinity (JSON 1e999 parses to Infinity) and the
  // numeric(8,2) overflow range — bad numbers get a 400, not a DB 500.
  const possible = finiteNumber(body.points_possible, { min: 0.01, max: MAX_POINTS })
  if (possible === null) return badRequest('invalid_points_possible')
  const earned = body.points_earned === null || body.points_earned === undefined
    ? null
    : finiteNumber(body.points_earned, { min: 0, max: MAX_POINTS })
  if (body.points_earned !== null && body.points_earned !== undefined && earned === null) {
    return badRequest('invalid_points_earned')
  }
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const service = createServiceClient()
  const { data, error } = await service.from('grade_items').insert({
    user_id: user.id,
    course_id: body.courseId,
    name: body.name.trim().slice(0, 200),
    category: body.category?.trim().slice(0, 80) || null,
    points_earned: earned,
    points_possible: possible,
    source: 'manual',
  }).select('item_id').single()
  if (error) return serverError('grades POST', error)
  return NextResponse.json({ ok: true, item_id: data.item_id })
}

export async function PATCH(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{
    itemId?: string; name?: string; category?: string | null
    points_earned?: number | null; points_possible?: number; confirmed?: boolean
  }>(request)
  if (!body) return badRequest('invalid_json')
  if (!body.itemId) return badRequest('missing_itemId')

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return badRequest('invalid_name')
    updates.name = body.name.trim().slice(0, 200)
  }
  if (body.category !== undefined) updates.category = (typeof body.category === 'string' ? body.category.trim().slice(0, 80) : '') || null
  if (body.points_earned !== undefined) {
    if (body.points_earned !== null && finiteNumber(body.points_earned, { min: 0, max: MAX_POINTS }) === null) return badRequest('invalid_points_earned')
    updates.points_earned = body.points_earned
  }
  if (body.points_possible !== undefined) {
    if (finiteNumber(body.points_possible, { min: 0.01, max: MAX_POINTS }) === null) return badRequest('invalid_points_possible')
    updates.points_possible = body.points_possible
  }
  // F1: confirm a pending upload-extracted grade (optionally alongside edits).
  if (body.confirmed !== undefined) updates.confirmed = body.confirmed === true
  if (Object.keys(updates).length === 0) return badRequest('no_updates')

  const service = createServiceClient()
  const { error } = await service.from('grade_items').update(updates).eq('item_id', body.itemId).eq('user_id', user.id)
  if (error) return serverError('grades PATCH', error)
  return NextResponse.json({ ok: true })
}

export async function PUT(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{ courseId?: string; scheme?: { category?: string; weight_pct?: number }[] }>(request)
  if (!body) return badRequest('invalid_json')
  if (!body.courseId || !Array.isArray(body.scheme)) return badRequest('missing_fields')
  if (!(await requireOwnedCourse(user.id, body.courseId))) return notFound('course_not_found')

  const cleaned = body.scheme
    .filter(s => typeof s.category === 'string' && s.category.trim().length > 0 &&
      finiteNumber(s.weight_pct, { min: 0.01, max: 100 }) !== null)
    .map(s => ({ category: (s.category as string).trim().slice(0, 80), weight_pct: Math.round((s.weight_pct as number) * 100) / 100 }))
    .slice(0, 12)

  // Dedupe case-insensitively: a payload with 'Exams' twice would violate the
  // (user_id, course_id, category) unique constraint mid-write.
  const seen = new Set<string>()
  const deduped = cleaned.filter(s => {
    const k = s.category.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const service = createServiceClient()
  // Replace via upsert-then-prune, NOT delete-then-insert: if anything fails
  // mid-way the student keeps a superset of their scheme instead of losing it
  // (the old order wiped the scheme whenever the insert errored).
  if (deduped.length > 0) {
    const { error: upError } = await service.from('course_grade_schemes').upsert(
      deduped.map(s => ({ user_id: user.id, course_id: body.courseId, ...s })),
      { onConflict: 'user_id,course_id,category' },
    )
    if (upError) return serverError('grades PUT upsert', upError)
  }
  // Prune categories no longer in the scheme (delete-all when scheme is empty).
  let prune = service.from('course_grade_schemes').delete().eq('user_id', user.id).eq('course_id', body.courseId)
  if (deduped.length > 0) {
    prune = prune.not('category', 'in', `(${deduped.map(s => `"${s.category.replace(/"/g, '')}"`).join(',')})`)
  }
  const { error: delError } = await prune
  if (delError) return serverError('grades PUT prune', delError)
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const user = await authedUser()
  if (!user) return unauthorized()

  const body = await readJson<{ itemId?: string }>(request)
  if (!body) return badRequest('invalid_json')
  const { itemId } = body
  if (!itemId) return badRequest('missing_itemId')

  const service = createServiceClient()
  const { error } = await service.from('grade_items').delete().eq('item_id', itemId).eq('user_id', user.id)
  if (error) return serverError('grades DELETE', error)
  return NextResponse.json({ ok: true })
}
