import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError, readJson, badRequest } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{ course_id?: unknown; name?: unknown; due_date?: unknown }>(request)
  if (!body) return badRequest('invalid_json')
  const { course_id, name, due_date } = body

  if (!course_id || !name || !due_date) {
    return NextResponse.json({ error: 'course_id, name, and due_date are required' }, { status: 400 })
  }

  // name/due_date go straight into the insert — type/shape-check them here so
  // bad input is a 400, not a Postgres coercion error → 500. name is capped at
  // 200 chars (the app-wide convention, e.g. grades POST) so a multi-megabyte
  // string can't bloat every dashboard/scheduler/ICS query that selects it.
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest('invalid_name')
  }
  if (typeof due_date !== 'string' || Number.isNaN(Date.parse(due_date))) {
    return badRequest('invalid_due_date')
  }
  const safeName = name.trim().slice(0, 200)

  const service = createServiceClient()

  // Verify the course belongs to this user
  const { data: course } = await service
    .from('courses')
    .select('course_id')
    .eq('course_id', course_id)
    .eq('user_id', user.id)
    .single()

  if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  const { data, error } = await service
    .from('assignments')
    .insert({
      user_id: user.id,
      course_id,
      name: safeName,
      due_date,
      type: 'homework',
      completion_status: 'pending',
    })
    .select('assignment_id')
    .single()

  if (error) return serverError('assignments:POST', error)

  return NextResponse.json({ ok: true, assignment_id: data.assignment_id })
}

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const patchBody = await readJson<{ assignment_id?: string }>(request)
  const assignment_id = patchBody?.assignment_id
  if (!assignment_id) return NextResponse.json({ error: 'assignment_id required' }, { status: 400 })

  const service = createServiceClient()
  const { error } = await service
    .from('assignments')
    .update({ completion_status: 'complete' })
    .eq('assignment_id', assignment_id)
    .eq('user_id', user.id)

  if (error) return serverError('assignments:PATCH', error)
  return NextResponse.json({ ok: true })
}
