import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { readWikiFile } from '@/lib/wiki'
import { getUserKey } from '@/lib/user-keys'
import { dateKeyInTimeZone } from '@/lib/time'
import { CourseDetailClient } from './_client'

export default async function CourseDetailPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()
  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', user.id)
    .single()
  const today = dateKeyInTimeZone(new Date(), userRow?.timezone ?? 'UTC')

  const [courseResult, resultsResult, materialsResult, examsResult, openaiKey] = await Promise.all([
    service
      .from('courses')
      .select(`
        course_id,
        name,
        course_type,
        icon,
        icon_color,
        professor_id,
        professors ( name ),
        topics (
          topic_id,
          name,
          syllabus_order,
          content_coverage,
          professor_weight,
          topic_mastery ( mastery_score ),
          flashcards ( card_id, fsrs_next_review_date )
        )
      `)
      .eq('course_id', courseId)
      .eq('user_id', user.id)
      .single(),
    service
      .from('practice_test_results')
      .select('result_id, test_type, score_pct, question_count, correct_count, topic_filter, created_at')
      .eq('user_id', user.id)
      .eq('course_id', courseId)
      .order('created_at', { ascending: false })
      .limit(20),
    service
      .from('materials')
      .select('material_id, tier, file_type, filename, processing_status, uploaded_at')
      .eq('course_id', courseId)
      .eq('user_id', user.id)
      .order('tier', { ascending: true })
      .order('uploaded_at', { ascending: false }),
    service
      .from('exams')
      .select('exam_id, date, grade_weight, duration_minutes, student_score')
      .eq('course_id', courseId)
      .eq('user_id', user.id)
      .order('date', { ascending: true }),
    getUserKey(user.id, 'openai_key'),
  ])

  if (!courseResult.data) redirect('/courses')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = courseResult.data as any
  const profName = Array.isArray(c.professors)
    ? c.professors[0]?.name ?? null
    : c.professors?.name ?? null

  const topics = (Array.isArray(c.topics) ? c.topics : [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => (a.syllabus_order ?? 999) - (b.syllabus_order ?? 999))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => {
      const cards: { card_id: string; fsrs_next_review_date: string }[] =
        Array.isArray(t.flashcards) ? t.flashcards : []
      const masteryRows = Array.isArray(t.topic_mastery) ? t.topic_mastery : []
      return {
        topic_id: t.topic_id,
        name: t.name,
        syllabus_order: t.syllabus_order,
        content_coverage: Number(t.content_coverage ?? 0),
        professor_weight: Number(t.professor_weight ?? 0.5),
        card_count: cards.length,
        due_count: cards.filter((card: { fsrs_next_review_date: string }) => card.fsrs_next_review_date <= today).length,
        mastery_score: masteryRows[0]?.mastery_score ?? null,
      }
    })

  const course = {
    course_id: c.course_id,
    name: c.name,
    course_type: c.course_type ?? null,
    icon: c.icon ?? null,
    icon_color: c.icon_color ?? null,
    professor_id: c.professor_id ?? null,
    professor_name: profName,
    topics,
  }

  // Fetch professor wiki summary
  let professorWiki: string | null = null
  if (c.professor_id) {
    professorWiki = await readWikiFile(user.id, `professor_${c.professor_id}.md`)
  }

  return (
    <CourseDetailClient
      course={course}
      testResults={resultsResult.data ?? []}
      materials={materialsResult.data ?? []}
      exams={examsResult.data ?? []}
      professorWiki={professorWiki}
      hasOpenAI={!!openaiKey}
    />
  )
}
