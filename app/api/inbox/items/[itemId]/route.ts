import { createClient, createServiceClient } from '@/lib/supabase/server'
import { requireOwnedCourse } from '@/lib/authz'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

type Params = { params: Promise<{ itemId: string }> }

// DELETE — dismiss the item (removes inbox record and associated material)
export async function DELETE(_req: Request, { params }: Params) {
  const { itemId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Fetch the item to get the material_id
  const { data: item } = await service
    .from('inbox_items')
    .select('material_id')
    .eq('inbox_item_id', itemId)
    .eq('user_id', user.id)
    .single()

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete inbox item (material cascades if FK set, otherwise delete separately)
  const { error: inboxDeleteError } = await service
    .from('inbox_items')
    .delete()
    .eq('inbox_item_id', itemId)
    .eq('user_id', user.id)
  if (inboxDeleteError) return serverError('inbox/dismiss', inboxDeleteError)
  if (item.material_id) {
    // Capture the storage path before deleting the row so we can clean up the object too.
    const { data: material } = await service
      .from('materials')
      .select('storage_path')
      .eq('material_id', item.material_id)
      .eq('user_id', user.id)
      .single()

    const { error: materialDeleteError } = await service.from('materials').delete().eq('material_id', item.material_id).eq('user_id', user.id)
    if (materialDeleteError) return serverError('inbox/dismiss', materialDeleteError)

    // Remove the orphaned storage object (best-effort — the DB rows are already gone).
    if (material?.storage_path) {
      const { error: storageError } = await service.storage.from('materials').remove([material.storage_path])
      if (storageError) console.error('[inbox/dismiss] failed to remove storage object', material.storage_path, storageError)
    }
  }

  return NextResponse.json({ ok: true })
}

// PATCH { courseId } — assign unassigned item to a course
export async function PATCH(request: Request, { params }: Params) {
  const { itemId } = await params
  const { courseId } = await request.json() as { courseId: string }

  if (!courseId) return NextResponse.json({ error: 'Missing courseId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const course = await requireOwnedCourse(user.id, courseId)
  if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  const { data: item } = await service
    .from('inbox_items')
    .select('material_id, tier')
    .eq('inbox_item_id', itemId)
    .eq('user_id', user.id)
    .single()

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Update inbox item
  const { error: inboxError } = await service.from('inbox_items').update({
    classification_status: 'classified',
    course_id: courseId,
  }).eq('inbox_item_id', itemId).eq('user_id', user.id)
  if (inboxError) return serverError('inbox/assign', inboxError)

  // Update material if it exists
  if (item.material_id) {
    const { error: materialError } = await service.from('materials').update({
      course_id: courseId,
      processing_status: 'processed',
    }).eq('material_id', item.material_id).eq('user_id', user.id)
    if (materialError) return serverError('inbox/assign', materialError)
  }

  return NextResponse.json({ ok: true })
}
