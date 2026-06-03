import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { course_id, name, due_date } = await request.json()

  if (!course_id || !name || !due_date) {
    return NextResponse.json({ error: 'course_id, name, and due_date are required' }, { status: 400 })
  }

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
      name,
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

  const { assignment_id } = await request.json()
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
