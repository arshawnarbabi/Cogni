import { createClient } from '@/lib/supabase/server'
import { generateSimulatedExam } from '@/lib/agents/practice-quiz'
import { requireOwnedCourse } from '@/lib/authz'
import { aiRouteGuard } from '@/lib/rate-limit'
import { NextResponse } from 'next/server'

const MOCK_EXAM = {
  durationMinutes: 60,
  questions: [
    {
      type: 'mc' as const,
      question: 'Evaluate ∫₀¹ x² dx.',
      options: ['1/4', '1/3', '1/2', '1'],
      answer: '1/3',
      explanation: 'Using the power rule: [x³/3]₀¹ = 1/3.',
      topic_name: 'Definite Integrals',
    },
    {
      type: 'mc' as const,
      question: 'Which of the following functions is NOT differentiable at x = 0?',
      options: ['f(x) = x²', 'f(x) = |x|', 'f(x) = sin(x)', 'f(x) = eˣ'],
      answer: 'f(x) = |x|',
      explanation: '|x| has a corner at x = 0, so the left and right derivatives differ.',
      topic_name: 'Differentiability',
    },
    {
      type: 'short_answer' as const,
      question: 'State L\'Hôpital\'s Rule and give one condition for its use.',
      answer: 'If lim f(x)/g(x) gives 0/0 or ∞/∞, then lim f(x)/g(x) = lim f\'(x)/g\'(x), provided the latter limit exists.',
      explanation: 'L\'Hôpital\'s rule resolves indeterminate forms by differentiating numerator and denominator separately.',
      topic_name: 'Limits',
    },
    {
      type: 'mc' as const,
      question: 'The Mean Value Theorem states that for f continuous on [a,b] and differentiable on (a,b), there exists c ∈ (a,b) such that:',
      options: [
        'f(c) = (f(a) + f(b)) / 2',
        'f\'(c) = (f(b) − f(a)) / (b − a)',
        'f\'(c) = f(b) − f(a)',
        'f(c) = f(b) − f(a)',
      ],
      answer: 'f\'(c) = (f(b) − f(a)) / (b − a)',
      explanation: 'MVT guarantees a point where the instantaneous rate equals the average rate of change.',
      topic_name: 'Mean Value Theorem',
    },
  ],
}

export async function POST(request: Request) {
  const body = await request.json() as { courseId: string; courseName: string }
  const { courseId, courseName } = body

  if (!courseId || !courseName) {
    return NextResponse.json({ error: 'Missing courseId or courseName' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  if (process.env.MOCK_AGENTS === 'true' && process.env.NODE_ENV !== 'production') {
    return NextResponse.json(MOCK_EXAM) // mock path is free — not rate-limited
  }

  const guard = await aiRouteGuard(user.id, 'simulated_exam')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  // Content guard — require at least some uploaded material
  const { createServiceClient } = await import('@/lib/supabase/server')
  const service = createServiceClient()
  const { data: topics } = await service
    .from('topics')
    .select('content_coverage')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .gt('content_coverage', 0.05)
    .limit(1)

  if (!topics || topics.length === 0) {
    return NextResponse.json({
      error: 'Not enough course material to generate a realistic simulated exam. Upload your syllabus, lecture notes, or textbook chapters first.',
    }, { status: 422 })
  }

  try {
    const result = await generateSimulatedExam(user.id, courseId, courseName)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
