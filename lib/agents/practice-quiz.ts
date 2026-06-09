import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { readWikiFile } from '@/lib/wiki'
import { applyMasteryEvidence, resolveTopicByName, effectiveMastery } from '@/lib/mastery'
import { withRetry } from '@/lib/ai/call'
import { recordUsage } from '@/lib/usage'
import { newCardDefaults } from '@/lib/fsrs'
import { assignNewCardDueDates } from '@/lib/agents/flashcard'
import Anthropic from '@anthropic-ai/sdk'

type TopicNameRow = { topic_id: string; name: string }
type TopicWeightRow = { name: string; professor_weight: number | null; content_coverage: number | null }

export type QuizFormat = 'mc' | 'short_answer' | 'mixed'

export type QuizQuestion = {
  question: string
  options?: string[]   // MC only — 4 choices
  answer: string       // correct option text (MC) or model answer (short answer)
  explanation: string
  topic_name?: string
  type: 'mc' | 'short_answer'
}

export type QuizResult = {
  question: QuizQuestion
  userAnswer: string
  correct: boolean
  score: number   // 0–1 (for short answer, partial credit possible)
  feedback?: string
}

export type GradeSummary = {
  correctCount: number
  scorePct: number
  missedTopics: { topic: string; wrongCount: number }[]
  masteryUpdates: { topic_id: string; topicName: string; oldScore: number; newScore: number }[]
  results: QuizResult[]
}

// ── Generate practice quiz questions (Haiku) ──────────────────────────────────

export async function generatePracticeQuiz(
  userId: string,
  courseId: string,
  courseName: string,
  format: QuizFormat,
  questionCount: number,
  topicFilter?: string,
  difficulty?: 'easy' | 'medium' | 'hard',
): Promise<QuizQuestion[]> {
  const apiKey = await getUserApiKey(userId)
  if (!apiKey) throw new Error('No API key')

  const service = createServiceClient()

  // Fetch topics — weak areas first (I1: effective/decayed mastery)
  const { data: mastery } = await service
    .from('topic_mastery')
    .select('mastery_score, last_updated, topics(topic_id, name)')
    .eq('user_id', userId)
    .order('mastery_score', { ascending: true })
    .limit(40)

  const { data: allTopics } = await service
    .from('topics')
    .select('topic_id, name')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .order('syllabus_order', { ascending: true })
    .limit(20)

  const masteryMap = new Map<string, number>()
  for (const m of mastery ?? []) {
    const t = m.topics as { topic_id: string; name: string } | null
    if (t) masteryMap.set(t.topic_id, effectiveMastery((m as { mastery_score: number | null }).mastery_score, (m as { last_updated: string | null }).last_updated))
  }

  const quizTopics = ((allTopics ?? []) as TopicNameRow[]).filter(t => !topicFilter || t.name.toLowerCase().includes(topicFilter.toLowerCase()))
  const topicList = quizTopics
    .map(t => `- ${t.name} (mastery: ${Math.round((masteryMap.get(t.topic_id) ?? 0) * 100)}%)`)
    .join('\n')

  // I7: when the caller didn't pin a difficulty, pick it from the student's
  // actual level on the quizzed topics — weak topics get confidence-building
  // recall, strong topics get synthesis/edge-case questions. A fixed 'medium'
  // wasted both ends.
  if (!difficulty) {
    const levels = quizTopics.map(t => masteryMap.get(t.topic_id) ?? 0)
    const avg = levels.length > 0 ? levels.reduce((s, v) => s + v, 0) / levels.length : 0
    difficulty = avg < 0.35 ? 'easy' : avg > 0.7 ? 'hard' : 'medium'
  }

  const formatInstruction =
    format === 'mc'
      ? 'Generate ONLY multiple-choice questions. Each question must have exactly 4 options.'
      : format === 'short_answer'
      ? 'Generate ONLY short-answer questions. No multiple choice.'
      : `Generate a mix: roughly 60% multiple-choice, 40% short-answer. Use "type": "mc" or "type": "short_answer".`

  const difficultyInstruction =
    difficulty === 'easy'
      ? 'Difficulty: EASY — straightforward recall questions, familiar phrasing, single-concept per question.'
      : difficulty === 'hard'
      ? 'Difficulty: HARD — synthesis questions, edge cases, multi-concept reasoning, tricky distractors.'
      : 'Difficulty: MEDIUM — standard exam-style questions, moderate complexity.'

  const client = new Anthropic({ apiKey })
  const response = await withRetry(() => client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Generate ${questionCount} practice quiz questions for ${courseName}.

${topicFilter ? `Focus specifically on: ${topicFilter}` : `Topics available (weighted toward low-mastery first):\n${topicList}`}

${formatInstruction}
${difficultyInstruction}

Return ONLY a JSON array of question objects. No markdown, no explanation.

Schema for each question:
{
  "type": "mc" | "short_answer",
  "question": "...",
  "options": ["A", "B", "C", "D"],  // MC only
  "answer": "exact option text",     // MC: exact matching option; short_answer: model answer
  "explanation": "brief explanation",
  "topic_name": "topic this tests"
}`,
      },
    ],
  }), { label: 'quiz.generate', keyHealth: { userId, provider: 'anthropic' } })
  recordUsage(userId, 'quiz', 'claude-haiku-4-5-20251001', response.usage)

  const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]'
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error('Quiz generation returned invalid JSON')
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray((parsed as { questions?: unknown }).questions)
        ? (parsed as { questions: unknown[] }).questions
        : [])
  if (arr.length === 0) throw new Error('Quiz generation returned no questions')
  return arr.slice(0, questionCount) as QuizQuestion[]
}

// ── Generate simulated exam questions (Sonnet) ────────────────────────────────

export async function generateSimulatedExam(
  userId: string,
  courseId: string,
  courseName: string,
): Promise<{ questions: QuizQuestion[]; durationMinutes: number }> {
  const apiKey = await getUserApiKey(userId)
  if (!apiKey) throw new Error('No API key')

  const service = createServiceClient()

  // Get exam info for timing — nearest upcoming exam (the one being prepared for)
  const today = new Date().toISOString().split('T')[0]
  const { data: upcomingExams } = await service
    .from('exams')
    .select('date, duration_minutes')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .gte('date', today)
    .order('date', { ascending: true })
    .limit(1)

  const durationMinutes = upcomingExams?.[0]?.duration_minutes ?? 60
  const questionCount = 20

  // Get professor wiki
  const { data: courseRow } = await service
    .from('courses')
    .select('professor_id')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .single()

  let professorWiki = ''
  if (courseRow?.professor_id) {
    professorWiki = await readWikiFile(userId, `professor_${courseRow.professor_id}.md`) ?? ''
  }

  // Get topics with professor weights
  const { data: topics } = await service
    .from('topics')
    .select('name, professor_weight, content_coverage')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .order('professor_weight', { ascending: false })
    .limit(20)

  const topicList = ((topics ?? []) as TopicWeightRow[])
    .map(t => `- ${t.name} (professor weight: ${Math.round(Number(t.professor_weight) * 100)}%)`)
    .join('\n')

  const client = new Anthropic({ apiKey })
  const response = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `Generate a realistic simulated exam for ${courseName} with ${questionCount} questions.

Professor patterns:
${professorWiki || 'No professor profile available — use standard academic exam style.'}

Topic distribution (by professor weight — weight toward higher-weighted topics):
${topicList || 'No topic data — distribute evenly.'}

Requirements:
- Mirror real exam style based on professor patterns
- Use varied question types: multiple-choice and short-answer
- Topic distribution should match professor_weight proportions (NOT weighted toward weak areas)
- Difficulty should match an actual exam

Return ONLY a JSON array. No markdown, no explanation.

Schema for each question:
{
  "type": "mc" | "short_answer",
  "question": "...",
  "options": ["A", "B", "C", "D"],
  "answer": "...",
  "explanation": "...",
  "topic_name": "..."
}`,
      },
    ],
  }), { label: 'quiz.simulated-exam', keyHealth: { userId, provider: 'anthropic' } })
  recordUsage(userId, 'quiz', 'claude-sonnet-4-6', response.usage)

  const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]'
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(stripped)
  const questions = (Array.isArray(parsed) ? parsed : []) as QuizQuestion[]
  if (questions.length === 0) throw new Error('Simulated exam generation returned no questions')

  return { questions: questions.slice(0, questionCount), durationMinutes }
}

// ── Grade results + update mastery + write to DB ──────────────────────────────

export async function gradeAndRecord(
  userId: string,
  courseId: string,
  testType: 'practice_quiz' | 'simulated_exam',
  questions: QuizQuestion[],
  userAnswers: string[],   // parallel to questions
  topicFilter?: string,
  durationSeconds?: number,
  apiKey?: string,
  masteryWeight = 0.6,     // 0.6 for standalone, 0.3 for in-session (tutor) quizzes
): Promise<GradeSummary> {
  const service = createServiceClient()

  // C3: grade ALL short-answer questions in ONE Haiku call. Previously one
  // sequential call per question — a 10-question quiz meant 10 serial round
  // trips the student sat through after submitting, at 10x the request overhead.
  const shortAnswerIdx: number[] = []
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].type !== 'mc' && (userAnswers[i] ?? '').trim()) shortAnswerIdx.push(i)
  }

  const gradedShort = new Map<number, { score: number; correct: boolean; feedback?: string }>()
  if (apiKey && shortAnswerIdx.length > 0) {
    try {
      const client = new Anthropic({ apiKey })
      const items = shortAnswerIdx
        .map((qi, n) => `#${n + 1}\nQuestion: ${questions[qi].question}\nModel answer: ${questions[qi].answer}\nStudent answer: ${userAnswers[qi]}`)
        .join('\n\n')
      const msg = await withRetry(() => client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.min(4096, 150 * shortAnswerIdx.length + 200),
        messages: [{
          role: 'user',
          content: `Grade these ${shortAnswerIdx.length} student answers.

${items}

Return ONLY a JSON array with exactly ${shortAnswerIdx.length} objects, one per item IN ORDER:
[{"score": 0.0-1.0, "correct": true/false, "feedback": "one sentence"}, ...]`,
        }],
      }), { label: 'quiz.grade-batch', retries: 2, keyHealth: { userId, provider: 'anthropic' } })
      recordUsage(userId, 'quiz', 'claude-haiku-4-5-20251001', msg.usage)
      const raw = msg.content[0].type === 'text' ? msg.content[0].text : '[]'
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const arrMatch = cleaned.match(/\[[\s\S]*\]/)
      const parsed = JSON.parse(arrMatch ? arrMatch[0] : cleaned)
      if (Array.isArray(parsed)) {
        parsed.slice(0, shortAnswerIdx.length).forEach((g: { score?: number; correct?: boolean; feedback?: string }, n: number) => {
          gradedShort.set(shortAnswerIdx[n], {
            score: Math.min(1, Math.max(0, Number(g?.score ?? 0))),
            correct: g?.correct === true,
            feedback: typeof g?.feedback === 'string' ? g.feedback : undefined,
          })
        })
      }
    } catch (e) {
      console.error('[practice-quiz] batch grading failed, using length heuristic', e)
    }
  }

  const results: QuizResult[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const ua = userAnswers[i] ?? ''

    if (q.type === 'mc') {
      const correct = ua.trim().toLowerCase() === q.answer.trim().toLowerCase()
      results.push({ question: q, userAnswer: ua, correct, score: correct ? 1 : 0 })
    } else if (gradedShort.has(i)) {
      const g = gradedShort.get(i)!
      results.push({ question: q, userAnswer: ua, correct: g.correct, score: g.score, feedback: g.feedback })
    } else if (apiKey && ua.trim()) {
      // Batch call failed — same length heuristic the per-question fallback used.
      const correct = ua.trim().length > 10
      results.push({ question: q, userAnswer: ua, correct, score: correct ? 0.5 : 0 })
    } else {
      results.push({ question: q, userAnswer: ua, correct: false, score: 0, feedback: 'Could not auto-grade' })
    }
  }

  // Tally
  const correctCount = results.filter(r => r.correct).length
  const totalScore = results.reduce((sum, r) => sum + r.score, 0)
  const scorePct = questions.length > 0 ? (totalScore / questions.length) * 100 : 0

  // Missed topics
  const topicWrong = new Map<string, number>()
  for (const r of results) {
    if (!r.correct && r.question.topic_name) {
      topicWrong.set(r.question.topic_name, (topicWrong.get(r.question.topic_name) ?? 0) + 1)
    }
  }
  const missedTopics = Array.from(topicWrong.entries()).map(([topic, wrongCount]) => ({ topic, wrongCount }))

  // Update mastery per topic
  const masteryUpdates: GradeSummary['masteryUpdates'] = []
  const topicScores = new Map<string, { correct: number; total: number }>()

  for (const r of results) {
    if (!r.question.topic_name) continue
    const existing = topicScores.get(r.question.topic_name) ?? { correct: 0, total: 0 }
    existing.correct += r.score
    existing.total += 1
    topicScores.set(r.question.topic_name, existing)
  }

  // Batched lookup: one query for all topics in the course, match in memory.
  // Previously this did 2 queries per topic (topic lookup + mastery fetch) in a loop.
  const { data: courseTopics } = await service
    .from('topics')
    .select('topic_id, name')
    .eq('course_id', courseId)
    .eq('user_id', userId)

  const topicRows = (courseTopics ?? []) as { topic_id: string; name: string }[]

  const resolvedTopics: { topicName: string; topic_id: string; newScore: number }[] = []
  for (const [topicName, scores] of topicScores) {
    // Shared resolution (lib/mastery): exact case-insensitive match, then longest
    // containment — same contract as the tutor's grade_answer path.
    const topic_id = resolveTopicByName(topicName, topicRows)
    if (!topic_id) continue
    resolvedTopics.push({ topicName, topic_id, newScore: scores.correct / scores.total })
  }

  if (resolvedTopics.length > 0) {
    // Unified mastery service (F3). masteryWeight is the learning rate — the EWMA
    // form is mathematically identical to the blend this path always used, so quiz
    // behavior is preserved; it now also writes the confidence column.
    try {
      const applied = await applyMasteryEvidence(
        userId,
        resolvedTopics.map(r => ({ topicId: r.topic_id, observed: r.newScore, learningRate: masteryWeight })),
      )
      const byTopic = new Map(applied.map(a => [a.topicId, a]))
      for (const r of resolvedTopics) {
        const a = byTopic.get(r.topic_id)
        if (a) masteryUpdates.push({ topic_id: r.topic_id, topicName: r.topicName, oldScore: a.oldScore, newScore: a.newScore })
      }
    } catch (e) {
      console.error('[practice-quiz] mastery evidence write failed', e)
    }
  }

  // I8: every missed question becomes a flashcard — a card built from a
  // demonstrated gap targets exactly what the student doesn't know, and it's
  // near-free (the question + explanation were already generated). Recall form:
  // front = the question (no options), back = answer + explanation. Paced
  // through the normal new-card budget and deduped against existing fronts.
  try {
    const missed = results.filter(r => !r.correct && r.question.question?.trim() && r.question.answer?.trim())
    if (missed.length > 0) {
      const fronts = missed.map(r => r.question.question.trim())
      const { data: existingCards } = await service
        .from('flashcards')
        .select('front')
        .eq('user_id', userId)
        .eq('course_id', courseId)
        .in('front', fronts)
      const existingFronts = new Set(((existingCards ?? []) as { front: string }[]).map(c => c.front))

      const newOnes = missed.filter(r => !existingFronts.has(r.question.question.trim())).slice(0, 8)
      if (newOnes.length > 0) {
        const { data: tzRow } = await service.from('users').select('timezone').eq('user_id', userId).maybeSingle()
        const dueDates = await assignNewCardDueDates(service, userId, newOnes.length, tzRow?.timezone ?? 'UTC')
        const defaults = newCardDefaults()
        const topicRowsForCards = (courseTopics ?? []) as { topic_id: string; name: string }[]
        const { error: cardError } = await service.from('flashcards').insert(
          newOnes.map((r, i) => ({
            user_id: userId,
            course_id: courseId,
            topic_id: r.question.topic_name ? resolveTopicByName(r.question.topic_name, topicRowsForCards) : null,
            front: r.question.question.trim(),
            back: `${r.question.answer.trim()}${r.question.explanation ? `\n\n${r.question.explanation.trim()}` : ''}`.slice(0, 2000),
            hint: null,
            ...defaults,
            fsrs_next_review_date: dueDates[i],
          }))
        )
        if (cardError) console.error('[practice-quiz] missed-question cards insert failed', cardError)
      }
    }
  } catch (e) {
    console.error('[practice-quiz] missed-question card generation failed (non-fatal)', e)
  }

  // S6: tie a simulated-exam attempt to the REAL exam it preps for, so attempt
  // trends per exam are queryable and the semester dashboard can cite them.
  let examId: string | null = null
  if (testType === 'simulated_exam') {
    const todayKey = new Date().toISOString().split('T')[0]
    const { data: nearest } = await service
      .from('exams').select('exam_id')
      .eq('user_id', userId).eq('course_id', courseId)
      .gte('date', todayKey).order('date', { ascending: true })
      .limit(1).maybeSingle()
    examId = nearest?.exam_id ?? null
  }

  // Write result record
  const { error: resultError } = await service.from('practice_test_results').insert({
    user_id: userId,
    course_id: courseId,
    test_type: testType,
    exam_id: examId,
    topic_filter: topicFilter ?? null,
    question_count: questions.length,
    correct_count: correctCount,
    score_pct: Math.round(scorePct * 100) / 100,
    missed_topics: missedTopics,
    mastery_updates: masteryUpdates,
    duration_seconds: durationSeconds ?? null,
  })
  if (resultError) console.error('[practice-quiz] result insert failed', resultError)

  return { correctCount, scorePct, missedTopics, masteryUpdates, results }
}
