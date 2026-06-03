import { createClient, createServiceClient } from '@/lib/supabase/server'
import { classifyMaterial } from '@/lib/agents/inbox'
import { aiRouteGuard } from '@/lib/rate-limit'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST(_request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId: id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: inboxItem } = await service
    .from('inbox_items')
    .select('inbox_item_id, material_id, classification_status, materials(filename, storage_path, file_type)')
    .eq('inbox_item_id', id)
    .eq('user_id', user.id)
    .single()

  if (!inboxItem) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Only re-classify items in a recoverable state — a successfully classified item
  // shouldn't be reprocessed (it wastes the quota unit + re-runs the nested profiler).
  const RETRYABLE = ['failed', 'unreadable', 'pending']
  if (!RETRYABLE.includes(inboxItem.classification_status)) {
    return NextResponse.json({ error: 'Item is not in a retryable state.' }, { status: 409 })
  }

  const mat = inboxItem.materials as { filename: string; storage_path: string; file_type: string } | null
  if (!mat?.storage_path) return NextResponse.json({ error: 'No material found' }, { status: 404 })

  // Reject suspended accounts + enforce the daily classification cap — only after
  // the cheap ownership/state checks, so a 404/409 never burns a quota unit.
  const guard = await aiRouteGuard(user.id, 'inbox_classify')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  // Reset statuses before retrying
  const { error: materialError } = await service
    .from('materials')
    .update({ processing_status: 'pending' })
    .eq('material_id', inboxItem.material_id)
    .eq('user_id', user.id)
  if (materialError) return serverError('inbox/retry', materialError)

  const { error: inboxError } = await service
    .from('inbox_items')
    .update({ classification_status: 'pending' })
    .eq('inbox_item_id', id)
    .eq('user_id', user.id)
  if (inboxError) return serverError('inbox/retry', inboxError)

  const result = await classifyMaterial(
    user.id,
    inboxItem.material_id,
    mat.storage_path,
    mat.filename,
    mat.file_type ?? 'txt',
  )

  return NextResponse.json({ ok: true, ...result })
}
