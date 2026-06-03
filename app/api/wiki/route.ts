import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

const BUCKET = 'wiki'
const HIDDEN = new Set(['index.md'])
// Machine-generated, append-only activity log. Shown read-only in the UI but not
// user-editable: editing it would insert a full-blob row that corrupts the
// append-based re-materialization in lib/wiki.ts appendToLog.
const READ_ONLY = new Set(['log.md'])

function isSafeFilename(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 128
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('..')
    && /^[a-zA-Z0-9._-]+$/.test(name)
}

// GET — list all wiki files with content
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const { data: files, error } = await service.storage.from(BUCKET).list(user.id, { limit: 100 })
  if (error) return serverError('wiki GET', error)

  type StorageFile = { name: string; updated_at?: string; created_at?: string }
  const visible = (files ?? []).filter((f: StorageFile) => !HIDDEN.has(f.name))

  const results = await Promise.all(
    visible.map(async (f: StorageFile) => {
      const { data } = await service.storage.from(BUCKET).download(`${user.id}/${f.name}`)
      const content = data ? await data.text() : ''
      return { filename: f.name, content, updated_at: f.updated_at ?? f.created_at ?? null }
    })
  )

  return NextResponse.json({ files: results })
}

// PATCH — update a wiki file's content
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { filename, content } = await request.json()
  if (!isSafeFilename(filename) || typeof content !== 'string') {
    return NextResponse.json({ error: 'filename and content required' }, { status: 400 })
  }
  if (content.length > 200_000) {
    return NextResponse.json({ error: 'content too large' }, { status: 413 })
  }
  if (HIDDEN.has(filename) || READ_ONLY.has(filename)) {
    return NextResponse.json({ error: 'Cannot edit this file' }, { status: 403 })
  }

  const service = createServiceClient()
  const { error } = await service.storage
    .from(BUCKET)
    .upload(`${user.id}/${filename}`, new Blob([content], { type: 'text/markdown' }), { upsert: true })

  if (error) return serverError('wiki PATCH', error)

  // Version record
  await service.from('wiki_versions').insert({
    user_id: user.id,
    file_path: filename,
    content,
    triggered_by_agent: 'user_edit',
  })

  return NextResponse.json({ ok: true })
}

// DELETE — remove a wiki file
export async function DELETE(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { filename } = await request.json()
  if (!isSafeFilename(filename)) return NextResponse.json({ error: 'filename required' }, { status: 400 })
  if (HIDDEN.has(filename) || READ_ONLY.has(filename)) {
    return NextResponse.json({ error: 'Cannot delete this file' }, { status: 403 })
  }

  const service = createServiceClient()
  const { error } = await service.storage.from(BUCKET).remove([`${user.id}/${filename}`])
  if (error) return serverError('wiki DELETE', error)

  return NextResponse.json({ ok: true })
}
