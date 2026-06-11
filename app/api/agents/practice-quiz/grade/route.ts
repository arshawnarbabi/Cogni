import { createClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { gradeAndRecord, type QuizQuestion } from '@/lib/agents/practice-quiz'
import { requireOwnedCourse } from '@/lib/authz'
import { aiRouteGuard } from '@/lib/rate-limit'
import { serverError, readJson, badRequest } from '@/lib/api-error'
import { NextResponse } from 'next/server'

// Grading short-answer questions makes one model call per question; bound the
// runtime so a large payload can't hold the function open indefinitely.
export const maxDuration = 60

// Hard cap on questions graded per request — defends against a client sending a
// huge `questions` array to fan out thousands of model calls / DB writes.
const MAX_QUESTIONS = 50

export async function POST(request: Request) {
  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{
    courseId: string
    testType: 'practice_quiz' | 'simulated_exam'
    questions: QuizQuestion[]
    userAnswers: string[]
    topicFilter?: string
    durationSeconds?: number
    inSession?: boolean   // true for tutor-generated quizzes → lighter mastery weight
  }>(request)
  if (!body) return badRequest('invalid_json')
  const { courseId, testType, questions, userAnswers, topicFilter, durationSeconds, inSession } = body

  if (!courseId || !Array.isArray(questions) || questions.length === 0) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }
  if (questions.length > MAX_QUESTIONS) {
    return NextResponse.json({ error: `Too many questions (max ${MAX_QUESTIONS})` }, { status: 413 })
  }
  // Shape-check BEFORE the daily 'grade' quota burn below: a missing userAnswers
  // array or a question without string answer/type previously TypeError'd inside
  // gradeAndRecord → 500, with the quota unit already consumed. testType also
  // feeds a DB CHECK constraint — fail fast with a 400.
  if (testType !== 'practice_quiz' && testType !== 'simulated_exam') {
    return badRequest('invalid_test_type')
  }
  if (!Array.isArray(userAnswers) || userAnswers.some(a => a != null && typeof a !== 'string')) {
    return badRequest('invalid_user_answers')
  }
  if (questions.some(q => !q || typeof q.question !== 'string' || typeof q.answer !== 'string'
      || (q.type !== 'mc' && q.type !== 'short_answer'))) {
    return badRequest('invalid_questions')
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  // Reject suspended accounts + enforce the daily grading cap. Grading uses its
  // own 'grade' bucket (separate from quiz/exam generation) so a user who hit the
  // generation cap can still grade what they already generated.
  const guard = await aiRouteGuard(user.id, 'grade')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const apiKey = await getUserApiKey(user.id)

  try {
    const summary = await gradeAndRecord(
      user.id,
      courseId,
      testType,
      questions,
      userAnswers,
      topicFilter,
      durationSeconds,
      apiKey ?? undefined,
      inSession ? 0.3 : 0.6,  // Option 2: lighter blend for in-session tutor quizzes
    )
    return NextResponse.json(summary)
  } catch (err) {
    return serverError('practice-quiz/grade', err)
  }
}
