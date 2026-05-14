import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runProfiler } from '@/lib/agents/profiler'
import { processEmbeddings } from '@/lib/rag'
import { requireOwnedCourse } from '@/lib/authz'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data } = await service
    .from('course_web_suggestions')
    .select('id, title, url, content, status')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({ suggestion: data ?? null })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { suggestionId } = await request.json() as { suggestionId: string }

  const service = createServiceClient()
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: suggestion } = await service
    .from('course_web_suggestions')
    .select('id, content, title')
    .eq('id', suggestionId)
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .single()

  if (!suggestion) return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })

  const { data: courseRow } = await service
    .from('courses')
    .select('name')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  const courseName = courseRow?.name ?? 'Course'
  const filename = `web_syllabus_${courseId}.txt`
  const storagePath = `${user.id}/syllabuses/${filename}`
  const contentBuffer = Buffer.from(suggestion.content, 'utf-8')

  const { error: uploadError } = await service.storage
    .from('materials')
    .upload(storagePath, contentBuffer, { contentType: 'text/plain', upsert: true })

  if (uploadError) {
    console.error('[web-suggestion] storage upload failed', uploadError)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const { data: material, error: materialError } = await service
    .from('materials')
    .insert({
      user_id: user.id,
      course_id: courseId,
      filename: suggestion.title ? `${suggestion.title}.txt` : filename,
      storage_path: storagePath,
      tier: 1,
      file_type: 'txt',
      processing_status: 'processed',
    })
    .select('material_id')
    .single()

  if (materialError || !material) {
    console.error('[web-suggestion] material insert failed', materialError)
    await service.storage.from('materials').remove([storagePath])
    return NextResponse.json({ error: 'Material insert failed' }, { status: 500 })
  }

  // Mark approved before running async jobs
  const { error: approveError } = await service
    .from('course_web_suggestions')
    .update({ status: 'approved' })
    .eq('id', suggestionId)
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  if (approveError) return NextResponse.json({ error: approveError.message }, { status: 500 })

  // Run profiler + RAG — both non-blocking from client perspective
  runProfiler(user.id, material.material_id, courseId, courseName).catch(e =>
    console.error('[web-suggestion] profiler failed', e)
  )
  processEmbeddings(user.id, material.material_id, suggestion.content).catch(e =>
    console.error('[web-suggestion] embeddings failed', e)
  )

  return NextResponse.json({ ok: true, materialId: material.material_id })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { suggestionId } = await request.json() as { suggestionId: string }

  const service = createServiceClient()
  const { error } = await service
    .from('course_web_suggestions')
    .update({ status: 'dismissed' })
    .eq('id', suggestionId)
    .eq('course_id', courseId)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
