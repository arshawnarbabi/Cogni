import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { serverError, readJson, badRequest, finiteNumber } from '@/lib/api-error'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string; examId: string }> }
) {
  const { courseId, examId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{ student_score: number | null }>(request)
  if (!body) return badRequest('invalid_json')
  const { student_score } = body

  // finiteNumber rejects non-numbers/NaN/Infinity — a string/boolean/object
  // previously slipped past the bare range comparisons and 500'd on the
  // numeric(5,2) column instead of returning a 400.
  if (student_score !== null && finiteNumber(student_score, { min: 0, max: 100 }) === null) {
    return NextResponse.json({ error: 'Score must be between 0 and 100' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data, error } = await service
    .from('exams')
    .update({ student_score: student_score ?? null })
    .eq('exam_id', examId)
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .select('exam_id')

  if (error) return serverError('courses/exams/update', error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'Exam not found' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
