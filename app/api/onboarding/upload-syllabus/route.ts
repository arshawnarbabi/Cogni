import { createClient, createServiceClient } from '@/lib/supabase/server'
import { hasExpectedFileSignature } from '@/lib/file-validation'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await request.formData()
  const file = form.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 25 MB).' }, { status: 413 })
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!['pdf', 'txt', 'md'].includes(ext)) {
    return NextResponse.json({ error: 'Unsupported file type. Upload a PDF, TXT, or MD.' }, { status: 400 })
  }
  if (!await hasExpectedFileSignature(file, ext)) {
    return NextResponse.json({ error: 'File contents do not match the file extension.' }, { status: 400 })
  }

  const service = createServiceClient()
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${user.id}/syllabuses/${Date.now()}_${safeName}`

  const { data, error } = await service.storage
    .from('materials')
    .upload(path, file, { upsert: false })

  if (error) return serverError('onboarding.uploadSyllabus', error)

  return NextResponse.json({ storagePath: data.path, fileName: file.name })
}
