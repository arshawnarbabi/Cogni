import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runProfiler } from '@/lib/agents/profiler'
import { aiRouteGuard } from '@/lib/rate-limit'
import { NextResponse } from 'next/server'

// POST { courseId } — re-runs the profiler on the first Tier 1 material for the course.
export async function POST(request: Request) {
  const { courseId } = await request.json() as { courseId: string }
  if (!courseId) return NextResponse.json({ error: 'Missing courseId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Reject suspended accounts + enforce the shared 'profiler' daily cap — this
  // on-demand re-run would otherwise bypass the cap applied at onboarding/create.
  const guard = await aiRouteGuard(user.id, 'profiler')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const service = createServiceClient()

  const { data: course } = await service
    .from('courses')
    .select('name')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  const { data: material } = await service
    .from('materials')
    .select('material_id')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .eq('tier', 1)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .single()

  if (!material) {
    return NextResponse.json({ error: 'No Tier 1 (syllabus) material found for this course' }, { status: 404 })
  }

  // Embed only if this syllabus has no chunks yet (covers syllabi from the
  // pre-B1-fix onboarding/create paths retroactively, without re-paying the
  // embedding bill for inbox-path materials that already have them).
  const { count: chunkCount } = await service
    .from('material_embeddings')
    .select('embedding_id', { count: 'exact', head: true })
    .eq('material_id', material.material_id)
    .eq('user_id', user.id)

  await runProfiler(user.id, material.material_id, courseId, course.name, { embed: (chunkCount ?? 0) === 0 })
  return NextResponse.json({ ok: true })
}
