import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runProfiler } from '@/lib/agents/profiler'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function POST() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  const { data: materials, error } = await service
    .from('materials')
    .select('material_id, course_id, filename, courses(name)')
    .eq('user_id', user.id)
    .eq('tier', 1)

  if (error) return serverError('dev/reprofile', error)
  if (!materials || materials.length === 0) {
    return NextResponse.json({ error: 'No tier-1 materials to re-profile' }, { status: 404 })
  }

  console.log(`[reprofile] running profiler on ${materials.length} syllabuses`)

  type Row = { material_id: string; course_id: string; filename: string; courses: { name: string } | { name: string }[] | null }
  const results = await Promise.allSettled(
    (materials as Row[]).map(m => {
      const courseName = Array.isArray(m.courses) ? m.courses[0]?.name : m.courses?.name
      return runProfiler(user.id, m.material_id, m.course_id, courseName ?? 'Unknown course')
    })
  )

  const summary = results.map((r, i) => ({
    file: (materials as Row[])[i].filename,
    status: r.status,
    reason: r.status === 'rejected' ? String(r.reason) : null,
  }))

  return NextResponse.json({ ok: true, summary })
}
