import { createClient, createServiceClient } from '@/lib/supabase/server'
import { classifyMaterial } from '@/lib/agents/inbox'
import { runScheduler } from '@/lib/agents/scheduler'
import { requireOwnedCourse } from '@/lib/authz'
import { hasExpectedFileSignature } from '@/lib/file-validation'
import { wouldExceedStorageLimit } from '@/lib/storage-quota'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await request.formData()
  const file = form.get('file') as File | null
  const textContent = form.get('textContent') as string | null
  const context = (form.get('context') as string | null) ?? undefined
  const courseIdHint = (form.get('courseId') as string | null) ?? undefined

  if (!file && !textContent) {
    return NextResponse.json({ error: 'No file or text content' }, { status: 400 })
  }

  const service = createServiceClient()

  if (courseIdHint) {
    const ownedCourse = await requireOwnedCourse(user.id, courseIdHint)
    if (!ownedCourse) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 })
    }
  }

  // Per-user storage ceiling (protects the shared free-tier project).
  const incomingBytes = file ? file.size : Buffer.byteLength(textContent ?? '', 'utf8')
  if (await wouldExceedStorageLimit(user.id, incomingBytes)) {
    return NextResponse.json({ error: 'Storage limit reached. Delete some materials to free up space.' }, { status: 413 })
  }

  let filename: string
  let ext: string
  let fileBlob: Blob
  let contentType: string

  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB
  if (file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'File too large (max 25 MB).' }, { status: 413 })
    }
    ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const allowedExts = ['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp']
    if (!allowedExts.includes(ext)) {
      return NextResponse.json({ error: 'Unsupported file type. Upload PDF, TXT, PNG, or JPG.' }, { status: 400 })
    }
    if (!await hasExpectedFileSignature(file, ext)) {
      return NextResponse.json({ error: 'File contents do not match the file extension.' }, { status: 400 })
    }
    filename = file.name
    fileBlob = file
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    }
    contentType = mimeMap[ext] ?? file.type ?? 'application/octet-stream'
  } else {
    if (textContent!.length > 500_000) {
      return NextResponse.json({ error: 'Text too long (max 500,000 chars).' }, { status: 413 })
    }
    // Text entry — store as a .txt material
    const label = (form.get('name') as string | null)?.trim() || 'Note'
    filename = `${label.replace(/[^a-zA-Z0-9 _-]/g, '').trim()}_${Date.now()}.txt`
    ext = 'txt'
    fileBlob = new Blob([textContent!], { type: 'text/plain' })
    contentType = 'text/plain'
  }

  // Reject duplicates by filename (files only, not text entries)
  // Exception: if the existing record is stuck pending (classification failed), allow re-upload
  if (file) {
    const { data: existing } = await service
      .from('materials')
      .select('material_id, processing_status, storage_path, uploaded_at')
      .eq('user_id', user.id)
      .eq('filename', filename)
      .limit(1)

    if (existing && existing.length > 0) {
      const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000 // 5 min
      const status = existing[0].processing_status
      const isStaleProcessing =
        status === 'processing' &&
        Date.now() - new Date(existing[0].uploaded_at).getTime() > PROCESSING_TIMEOUT_MS
      const stuck = status === 'pending' || status === 'failed' || isStaleProcessing
      if (!stuck) {
        return NextResponse.json(
          { error: `"${filename}" has already been uploaded.` },
          { status: 409 }
        )
      }
      // Stuck record — remove the orphaned storage object and delete the DB row
      // so this upload can proceed cleanly.
      if (existing[0].storage_path) {
        await service.storage.from('materials').remove([existing[0].storage_path])
      }
      await service
        .from('materials')
        .delete()
        .eq('material_id', existing[0].material_id)
        .eq('user_id', user.id)
    }
  }

  const storagePath = `${user.id}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`

  const { error: uploadError } = await service.storage
    .from('materials')
    .upload(storagePath, fileBlob, { contentType, upsert: false })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: material, error: materialError } = await service
    .from('materials')
    .insert({
      user_id: user.id,
      filename,
      storage_path: storagePath,
      file_type: file ? ext : 'typed',
      tier: null,
      processing_status: 'pending',
    })
    .select('material_id')
    .single()

  if (materialError || !material) {
    await service.storage.from('materials').remove([storagePath])
    return NextResponse.json({ error: materialError?.message ?? 'DB error' }, { status: 500 })
  }

  const { data: inboxItem, error: inboxError } = await service
    .from('inbox_items')
    .insert({
      user_id: user.id,
      material_id: material.material_id,
      classification_status: 'pending',
    })
    .select('inbox_item_id')
    .single()

  if (inboxError || !inboxItem) {
    await service.storage.from('materials').remove([storagePath])
    await service.from('materials').delete().eq('material_id', material.material_id).eq('user_id', user.id)
    return NextResponse.json({ error: inboxError?.message ?? 'DB error' }, { status: 500 })
  }

  let result
  try {
    result = await classifyMaterial(
      user.id,
      material.material_id,
      storagePath,
      filename,
      ext,
      context,
      courseIdHint,
    )
  } catch (e) {
    // Mark material as failed so the duplicate check allows retry next time
    await service
      .from('materials')
      .update({ processing_status: 'failed' })
      .eq('material_id', material.material_id)
      .eq('user_id', user.id)
    // Flip the inbox item to a recoverable status so the UI exposes retry/dismiss
    // (a 'pending' item shows no recovery actions, stranding the user).
    await service
      .from('inbox_items')
      .update({ classification_status: 'failed' })
      .eq('material_id', material.material_id)
      .eq('user_id', user.id)
    return NextResponse.json(
      { error: `File was saved but classification failed: ${e instanceof Error ? e.message : 'unknown error'}. Try uploading again.` },
      { status: 500 }
    )
  }

  // Fire-and-forget: rerun scheduler so today's plan reflects the new material
  runScheduler(user.id).catch(e =>
    console.error('[inbox/upload] runScheduler failed', e)
  )

  return NextResponse.json({ ok: true, inbox_item_id: inboxItem.inbox_item_id, ...result })
}
