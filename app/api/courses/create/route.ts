import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runProfiler } from '@/lib/agents/profiler'
import { getUserApiKey } from '@/lib/vault'
import { requireOwnedProfessor } from '@/lib/authz'
import { isUserSuspended, consumeAiQuota } from '@/lib/rate-limit'
import { hasExpectedFileSignature } from '@/lib/file-validation'
import { ICON_NAMES } from '@/lib/course-icon-names'
import { serverError } from '@/lib/api-error'
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

async function assignCourseIcon(userId: string, courseId: string, courseName: string) {
  const apiKey = await getUserApiKey(userId)
  if (!apiKey) return
  const client = new Anthropic({ apiKey })
  const iconList = ICON_NAMES.join(', ')
  const colorList = 'blue, violet, emerald, amber, rose, cyan, orange, indigo'
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `Course: "${courseName}". Icons: ${iconList}. Colors: ${colorList}. Pick the best icon and color. JSON only: {"icon":"Name","color":"id"}`,
      }],
    })
    const text = (msg.content[0] as { type: 'text'; text: string }).text
    const match = text.match(/\{[^}]+\}/)
    if (!match) return
    const parsed = JSON.parse(match[0])
    if (!(ICON_NAMES as readonly string[]).includes(parsed.icon)) return
    const service = createServiceClient()
    await service
      .from('courses')
      .update({ icon: parsed.icon, icon_color: parsed.color ?? 'blue' })
      .eq('course_id', courseId)
      .eq('user_id', userId)
  } catch { /* silent — icon assignment is best-effort */ }
}

function inferFileType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md') return 'md'
  return 'txt'
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (await isUserSuspended(user.id)) {
    return NextResponse.json({ error: 'Account suspended.' }, { status: 403 })
  }

  const form = await request.formData()
  const name = ((form.get('name') as string) ?? '').trim()
  const professorName = ((form.get('professorName') as string) ?? '').trim()
  const existingProfessorId = ((form.get('existingProfessorId') as string) ?? '').trim() || null
  const syllabus = form.get('syllabus') as File | null

  if (!name || !professorName) {
    return NextResponse.json({ error: 'Course name and professor name are required.' }, { status: 400 })
  }

  const service = createServiceClient()

  let professorId = existingProfessorId
  if (professorId) {
    const ownedProfessor = await requireOwnedProfessor(user.id, professorId)
    if (!ownedProfessor) {
      return NextResponse.json({ error: 'Professor not found' }, { status: 404 })
    }
  }

  if (!professorId) {
    // Upsert by (user_id, name) so adding a course for an existing professor
    // reuses that professor instead of creating a duplicate (race-safe via the
    // professors_user_name_uniq index).
    const { data: prof, error: profError } = await service
      .from('professors')
      .upsert({ user_id: user.id, name: professorName.trim() }, { onConflict: 'user_id,name' })
      .select('professor_id')
      .single()

    if (profError || !prof) {
      return serverError('courses/create:professor', profError)
    }
    professorId = prof.professor_id
  }

  const { data: courseRow, error: courseError } = await service
    .from('courses')
    .insert({ user_id: user.id, professor_id: professorId, name })
    .select('course_id')
    .single()

  if (courseError || !courseRow) {
    return serverError('courses/create:course', courseError)
  }

  const courseId = courseRow.course_id

  // Await icon assignment so it's committed before the client refreshes
  await assignCourseIcon(user.id, courseId, name).catch(e =>
    console.error('[courses/create] assignCourseIcon failed', e)
  )

  if (syllabus && syllabus.size > 0) {
    const ext = syllabus.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['pdf', 'txt', 'md'].includes(ext)) {
      return NextResponse.json({ ok: true, courseId, warning: 'Course created, but syllabus must be PDF, TXT, or MD.' })
    }
    if (!await hasExpectedFileSignature(syllabus, ext)) {
      return NextResponse.json({ ok: true, courseId, warning: 'Course created, but syllabus contents did not match its extension.' })
    }

    const safeName = syllabus.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${user.id}/syllabuses/${Date.now()}_${safeName}`

    const { error: uploadError } = await service.storage
      .from('materials')
      .upload(path, syllabus, { upsert: false })

    if (uploadError) {
      console.error('[courses/create] syllabus upload failed', uploadError)
      return NextResponse.json({ ok: true, courseId, warning: 'Course created, but the syllabus upload failed.' })
    }

    const { data: material, error: materialError } = await service
      .from('materials')
      .insert({
        user_id: user.id,
        course_id: courseId,
        filename: syllabus.name,
        storage_path: path,
        tier: 1,
        file_type: inferFileType(syllabus.name),
        processing_status: 'processed',
      })
      .select('material_id')
      .single()

    if (materialError || !material) {
      console.error('[courses/create] syllabus metadata insert failed', materialError)
      await service.storage.from('materials').remove([path])
      return NextResponse.json({ ok: true, courseId, warning: 'Course created, but saving the syllabus failed.' })
    }

    // Cap the syllabus-analysis AI work (shared 'profiler' daily quota with
    // onboarding). The course is already created; only enrichment is skipped.
    if (await consumeAiQuota(user.id, 'profiler')) {
      try {
        // embed: this insert path skips the inbox pipeline, so the profiler must
        // embed the syllabus for RAG (it was previously never embedded).
        await runProfiler(user.id, material.material_id, courseId, name, { embed: true })
      } catch (e) {
        console.error('[courses/create] profiler failed', e)
      }
    } else {
      console.warn(`[courses/create] profiler skipped for ${user.id} — daily AI cap reached`)
    }
  }

  // Return hasSyllabus so the client knows whether to trigger web enrichment
  return NextResponse.json({ ok: true, courseId, hasSyllabus: !!(syllabus && syllabus.size > 0) })
}
