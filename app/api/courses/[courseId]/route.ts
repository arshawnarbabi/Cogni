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

  // Delete course files from storage (course_files DB rows cascade with the course,
  // but the binary objects in the course-files bucket must be removed explicitly).
  const { data: courseFiles } = await service
    .from('course_files')
    .select('storage_path')
    .eq('course_id', courseId)
    .eq('user_id', user.id)

  const filePaths = (courseFiles ?? [])
    .map((f: { storage_path: string }) => f.storage_path)
    .filter(Boolean)

  if (filePaths.length > 0) {
    const { error: filesError } = await service.storage.from('course-files').remove(filePaths)
    if (filesError) return NextResponse.json({ error: filesError.message }, { status: 500 })
  }

  // Explicitly delete materials and their embeddings. materials.course_id is
  // `on delete set null` (NOT cascade), so deleting the course would otherwise
  // orphan material rows and their embeddings. Delete embeddings before materials
  // so this works whether or not the materials->embeddings cascade is intact.
  const { data: materialRows } = await service
    .from('materials')
    .select('material_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  const materialIds = (materialRows ?? []).map((m: { material_id: string }) => m.material_id)

  if (materialIds.length > 0) {
    const { error: embErr } = await service
      .from('material_embeddings')
      .delete()
      .in('material_id', materialIds)
      .eq('user_id', user.id)
    if (embErr) return NextResponse.json({ error: embErr.message }, { status: 500 })

    const { error: matErr } = await service
      .from('materials')
      .delete()
      .eq('course_id', courseId)
      .eq('user_id', user.id)
    if (matErr) return NextResponse.json({ error: matErr.message }, { status: 500 })
  }

  // Delete course row — cascades to topics, flashcards, test_results, session_messages.
  // Materials/embeddings are deleted explicitly above because materials.course_id is set-null, not cascade.
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
