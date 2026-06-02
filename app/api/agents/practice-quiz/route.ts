import { createClient } from '@/lib/supabase/server'
import { generatePracticeQuiz, type QuizFormat } from '@/lib/agents/practice-quiz'
import { requireOwnedCourse } from '@/lib/authz'
import { NextResponse } from 'next/server'

const MOCK_QUESTIONS = [
  {
    type: 'mc' as const,
    question: 'What is the derivative of sin(x)?',
    options: ['cos(x)', '-cos(x)', 'sin(x)', '-sin(x)'],
    answer: 'cos(x)',
    explanation: 'The derivative of sin(x) is cos(x) by the standard trigonometric derivative rules.',
    topic_name: 'Derivatives',
  },
  {
    type: 'mc' as const,
    question: 'Which integration technique is used for ∫x·eˣ dx?',
    options: ['Substitution', 'Integration by parts', 'Partial fractions', 'Trigonometric substitution'],
    answer: 'Integration by parts',
    explanation: 'Integration by parts (∫u dv = uv − ∫v du) is used when the integrand is a product of two functions.',
    topic_name: 'Integration Techniques',
  },
  {
    type: 'short_answer' as const,
    question: 'State the Fundamental Theorem of Calculus (Part 1).',
    answer: 'If f is continuous on [a,b] and F(x) = ∫ₐˣ f(t)dt, then F\'(x) = f(x).',
    explanation: 'Part 1 links differentiation and integration: the derivative of an integral recovers the original function.',
    topic_name: 'Fundamental Theorem',
  },
]

export async function POST(request: Request) {
  const body = await request.json() as {
    courseId: string
    courseName: string
    format: QuizFormat
    questionCount: number
    topicFilter?: string
    difficulty?: 'easy' | 'medium' | 'hard'
  }
  const { courseId, courseName, format, questionCount, topicFilter, difficulty } = body

  if (!courseId || !courseName) {
    return NextResponse.json({ error: 'Missing courseId or courseName' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  if (process.env.MOCK_AGENTS === 'true' && process.env.NODE_ENV !== 'production') {
    const count = Math.min(questionCount ?? 3, MOCK_QUESTIONS.length)
    return NextResponse.json({ questions: MOCK_QUESTIONS.slice(0, count) })
  }

  try {
    const questions = await generatePracticeQuiz(
      user.id,
      courseId,
      courseName,
      format,
      questionCount,
      topicFilter,
      difficulty,
    )
    return NextResponse.json({ questions })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
