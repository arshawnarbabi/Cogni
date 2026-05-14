import { createClient } from '@/lib/supabase/server'
import { runWebEnrichment } from '@/lib/agents/web-enrichment'
import { getUserApiKey } from '@/lib/vault'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = await getUserApiKey(user.id)
  if (!apiKey) return NextResponse.json({ error: 'No API key' }, { status: 402 })

  const service = (await import('@/lib/supabase/server')).createServiceClient()
  const { data: courseRow } = await service
    .from('courses')
    .select('name, professors(name)')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  if (!courseRow) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  const courseName = courseRow.name as string
  const prof = courseRow.professors as { name: string } | { name: string }[] | null
  const professorName: string = Array.isArray(prof) ? (prof[0]?.name ?? '') : (prof?.name ?? '')

  await runWebEnrichment(user.id, courseId, courseName, professorName, apiKey)

  return NextResponse.json({ ok: true })
}
