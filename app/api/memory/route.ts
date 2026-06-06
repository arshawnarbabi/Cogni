import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Memory center (M7): persistent memory about a student must be inspectable,
// correctable, and deletable BY the student — auto-extracted memory will
// sometimes be wrong, and memory they can't see feels like surveillance.
//   GET    → everything the tutor remembers (digests + facts + session summaries)
//   PATCH  → { pause: boolean } stop/resume writing new memory
//   DELETE → { memoryId } | { summaryId } | { courseId } (forget course) | { all: true }

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const [{ data: userRow }, { data: digests }, { data: facts }, { data: summaries }, { data: courses }] = await Promise.all([
    service.from('users').select('memory_paused').eq('user_id', user.id).maybeSingle(),
    service.from('course_memory').select('course_id, digest, updated_at').eq('user_id', user.id),
    service.from('student_memory').select('memory_id, course_id, kind, content, last_seen').eq('user_id', user.id).order('last_seen', { ascending: false }).limit(100),
    service.from('session_summaries').select('summary_id, course_id, summary, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
    service.from('courses').select('course_id, name').eq('user_id', user.id),
  ])

  const courseNames: Record<string, string> = {}
  for (const c of (courses ?? []) as { course_id: string; name: string }[]) courseNames[c.course_id] = c.name

  return NextResponse.json({
    paused: userRow?.memory_paused === true,
    courseNames,
    digests: digests ?? [],
    facts: facts ?? [],
    summaries: summaries ?? [],
  })
}

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { pause } = await request.json() as { pause?: boolean }
  if (typeof pause !== 'boolean') return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  const service = createServiceClient()
  const { error } = await service.from('users').update({ memory_paused: pause }).eq('user_id', user.id)
  if (error) return serverError('memory PATCH', error)
  return NextResponse.json({ ok: true, paused: pause })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as { memoryId?: string; summaryId?: string; courseId?: string; all?: boolean }
  const service = createServiceClient()

  try {
    if (body.all === true) {
      // Forget everything — hard deletes, the student's call.
      await Promise.all([
        service.from('student_memory').delete().eq('user_id', user.id),
        service.from('course_memory').delete().eq('user_id', user.id),
        service.from('session_summaries').delete().eq('user_id', user.id),
      ])
    } else if (body.courseId) {
      await Promise.all([
        service.from('student_memory').delete().eq('user_id', user.id).eq('course_id', body.courseId),
        service.from('course_memory').delete().eq('user_id', user.id).eq('course_id', body.courseId),
        service.from('session_summaries').delete().eq('user_id', user.id).eq('course_id', body.courseId),
      ])
    } else if (body.memoryId) {
      await service.from('student_memory').delete().eq('user_id', user.id).eq('memory_id', body.memoryId)
    } else if (body.summaryId) {
      await service.from('session_summaries').delete().eq('user_id', user.id).eq('summary_id', body.summaryId)
    } else {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
  } catch (e) {
    return serverError('memory DELETE', e)
  }

  return NextResponse.json({ ok: true })
}
