import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ICON_NAMES } from '@/lib/course-icon-names'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: course } = await service
    .from('courses')
    .select('course_id, professor_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  if (!course) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete material files from storage
  const { data: materials } = await service
    .from('materials')
    .select('storage_path')
    .eq('course_id', courseId)
    .eq('user_id', user.id)

  const storagePaths = (materials ?? [])
    .map((m: { storage_path: string }) => m.storage_path)
    .filter(Boolean)

  if (storagePaths.length > 0) {
    const { error: storageError } = await service.storage.from('materials').remove(storagePaths)
    if (storageError) return NextResponse.json({ error: storageError.message }, { status: 500 })
  }

  // Delete professor wiki file
  if (course.professor_id) {
    await service.storage
      .from('wiki')
      .remove([`${user.id}/professor_${course.professor_id}.md`])
  }

  // Delete course row — cascades to topics, flashcards, materials, test_results, session_messages
  const { error: deleteError } = await service
    .from('courses')
    .delete()
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { courseId } = await params
  const { icon, icon_color } = await request.json()

  if (!icon || !ICON_NAMES.includes(icon)) {
    return NextResponse.json({ error: 'Invalid icon' }, { status: 400 })
  }

  const service = createServiceClient()
  const { error } = await service
    .from('courses')
    .update({ icon, icon_color: icon_color ?? 'blue' })
    .eq('course_id', courseId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
