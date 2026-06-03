import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string; examId: string }> }
) {
  const { courseId, examId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { student_score } = await request.json() as { student_score: number | null }

  if (student_score !== null && (student_score < 0 || student_score > 100)) {
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Exam not found' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
