import { createClient } from '@/lib/supabase/server'
import { listCourseFiles, uploadCourseFile, deleteCourseFile, getFileUrl } from '@/lib/course-files'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/** GET /api/courses/files?courseId=xxx  → list files + signed URLs */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const courseId = searchParams.get('courseId')
  if (!courseId) return NextResponse.json({ error: 'Missing courseId' }, { status: 400 })

  const files = await listCourseFiles(user.id, courseId)
  const withUrls = await Promise.all(
    files.map(async f => ({ ...f, url: await getFileUrl(user.id, f.file_id) }))
  )
  return NextResponse.json({ files: withUrls })
}

/** POST /api/courses/files  — multipart/form-data: courseId + file */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await request.formData()
  const courseId = form.get('courseId') as string | null
  const file = form.get('file') as File | null

  if (!courseId || !file) {
    return NextResponse.json({ error: 'Missing courseId or file' }, { status: 400 })
  }

  const MAX_MB = 20
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File too large (max ${MAX_MB} MB)` }, { status: 413 })
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!['pdf', 'txt', 'md', 'docx', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    return NextResponse.json({ error: 'Unsupported file type.' }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const record = await uploadCourseFile(user.id, courseId, {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes,
  })

  return NextResponse.json({ file: record })
}

/** DELETE /api/courses/files  — body: { fileId } */
export async function DELETE(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { fileId } = await request.json() as { fileId: string }
  if (!fileId) return NextResponse.json({ error: 'Missing fileId' }, { status: 400 })

  await deleteCourseFile(user.id, fileId)
  return NextResponse.json({ ok: true })
}
