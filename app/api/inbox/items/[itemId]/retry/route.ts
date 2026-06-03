import { createClient, createServiceClient } from '@/lib/supabase/server'
import { classifyMaterial } from '@/lib/agents/inbox'
import { NextResponse } from 'next/server'

export async function POST(_request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId: id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: inboxItem } = await service
    .from('inbox_items')
    .select('inbox_item_id, material_id, materials(filename, storage_path, file_type)')
    .eq('inbox_item_id', id)
    .eq('user_id', user.id)
    .single()

  if (!inboxItem) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const mat = inboxItem.materials as { filename: string; storage_path: string; file_type: string } | null
  if (!mat?.storage_path) return NextResponse.json({ error: 'No material found' }, { status: 404 })

  // Reset statuses before retrying
  const { error: materialError } = await service
    .from('materials')
    .update({ processing_status: 'pending' })
    .eq('material_id', inboxItem.material_id)
    .eq('user_id', user.id)
  if (materialError) return NextResponse.json({ error: materialError.message }, { status: 500 })

  const { error: inboxError } = await service
    .from('inbox_items')
    .update({ classification_status: 'pending' })
    .eq('inbox_item_id', id)
    .eq('user_id', user.id)
  if (inboxError) return NextResponse.json({ error: inboxError.message }, { status: 500 })

  const result = await classifyMaterial(
    user.id,
    inboxItem.material_id,
    mat.storage_path,
    mat.filename,
    mat.file_type ?? 'txt',
  )

  return NextResponse.json({ ok: true, ...result })
}
