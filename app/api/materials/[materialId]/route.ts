import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const { materialId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Verify ownership and get storage path
  const { data: material } = await service
    .from('materials')
    .select('material_id, storage_path, user_id')
    .eq('material_id', materialId)
    .eq('user_id', user.id)
    .single()

  if (!material) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete from storage
  if (material.storage_path) {
    const { error: storageError } = await service.storage.from('materials').remove([material.storage_path])
    if (storageError) return serverError('materials.DELETE.storage', storageError)
  }

  // Delete DB row (cascades to embeddings if foreign key is set)
  const { error: deleteError } = await service
    .from('materials')
    .delete()
    .eq('material_id', materialId)
    .eq('user_id', user.id)
  if (deleteError) return serverError('materials.DELETE', deleteError)

  return NextResponse.json({ ok: true })
}
