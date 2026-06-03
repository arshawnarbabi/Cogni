import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { readWikiFile } from '@/lib/wiki'
import Anthropic from '@anthropic-ai/sdk'

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
  difficulty: 'easy' | 'medium' | 'hard' = 'medium',
): Promise<QuizQuestion[]> {
  const apiKey = await getUserApiKey(userId)
  if (!apiKey) throw new Error('No API key')

  const service = createServiceClient()

  // Fetch topics — weak areas first
  const { data: mastery } = await service
    .from('topic_mastery')
    .select('mastery_score, topics(topic_id, name)')
    .eq('user_id', userId)
    .order('mastery_score', { ascending: true })
    .limit(20)

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
    if (t) masteryMap.set(t.topic_id, Number(m.mastery_score ?? 0))
  }

  const topicList = (allTopics ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((t: any) => !topicFilter || t.name.toLowerCase().includes(topicFilter.toLowerCase()))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => `- ${t.name} (mastery: ${Math.round((masteryMap.get(t.topic_id) ?? 0) * 100)}%)`)
    .join('\n')

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
  const response = await client.messages.create({
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
  })

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

  const topicList = (topics ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => `- ${t.name} (professor weight: ${Math.round(Number(t.professor_weight) * 100)}%)`)
    .join('\n')

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
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
  })

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

  // Grade each question
  const results: QuizResult[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const ua = userAnswers[i] ?? ''

    if (q.type === 'mc') {
      const correct = ua.trim().toLowerCase() === q.answer.trim().toLowerCase()
      results.push({ question: q, userAnswer: ua, correct, score: correct ? 1 : 0 })
    } else {
      // Short answer — use Haiku if apiKey available
      if (apiKey && ua.trim()) {
        const client = new Anthropic({ apiKey })
        try {
          const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: `Grade this student answer.
Question: ${q.question}
Model answer: ${q.answer}
Student answer: ${ua}
Return JSON only: {"score": 0.0-1.0, "correct": true/false, "feedback": "one sentence"}`,
            }],
          })
          const raw = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
          const g = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
          results.push({ question: q, userAnswer: ua, correct: !!g.correct, score: g.score ?? 0, feedback: g.feedback })
        } catch {
          const correct = ua.trim().length > 10
          results.push({ question: q, userAnswer: ua, correct, score: correct ? 0.5 : 0 })
        }
      } else {
        results.push({ question: q, userAnswer: ua, correct: false, score: 0, feedback: 'Could not auto-grade' })
      }
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

  const topicByName = new Map<string, string>()
  for (const t of (courseTopics ?? []) as { topic_id: string; name: string }[]) {
    topicByName.set(t.name.toLowerCase(), t.topic_id)
  }

  const resolvedTopics: { topicName: string; topic_id: string; newScore: number }[] = []
  for (const [topicName, scores] of topicScores) {
    const needle = topicName.toLowerCase()
    let topic_id = topicByName.get(needle)   // exact match wins
    if (!topic_id) {
      // fallback: pick the longest matching candidate deterministically
      let bestName = ''
      for (const [name, id] of topicByName) {
        if (name.includes(needle) || needle.includes(name)) {
          if (name.length > bestName.length) { bestName = name; topic_id = id }
        }
      }
    }
    if (!topic_id) continue
    resolvedTopics.push({ topicName, topic_id, newScore: scores.correct / scores.total })
  }

  if (resolvedTopics.length > 0) {
    const topicIds = resolvedTopics.map(r => r.topic_id)
    const { data: existingRows } = await service
      .from('topic_mastery')
      .select('topic_id, mastery_score')
      .eq('user_id', userId)
      .in('topic_id', topicIds)

    const existingByTopic = new Map<string, number>()
    for (const row of (existingRows ?? []) as { topic_id: string; mastery_score: number | null }[]) {
      existingByTopic.set(row.topic_id, Number(row.mastery_score ?? 0))
    }

    const nowIso = new Date().toISOString()
    const masteryUpserts: { user_id: string; topic_id: string; mastery_score: number; last_updated: string }[] = []
    const historyInserts: { user_id: string; topic_id: string; mastery_score: number }[] = []

    for (const r of resolvedTopics) {
      const oldScore = existingByTopic.get(r.topic_id) ?? 0
      const hadExisting = existingByTopic.has(r.topic_id)
      const blended = hadExisting ? oldScore * (1 - masteryWeight) + r.newScore * masteryWeight : r.newScore
      const finalScore = Math.min(1, Math.max(0, blended))

      masteryUpserts.push({ user_id: userId, topic_id: r.topic_id, mastery_score: finalScore, last_updated: nowIso })
      historyInserts.push({ user_id: userId, topic_id: r.topic_id, mastery_score: finalScore })
      masteryUpdates.push({ topic_id: r.topic_id, topicName: r.topicName, oldScore, newScore: finalScore })
    }

    if (masteryUpserts.length > 0) {
      const { error: masteryError } = await service
        .from('topic_mastery')
        .upsert(masteryUpserts, { onConflict: 'user_id,topic_id' })
      if (masteryError) console.error('[practice-quiz] mastery upsert failed', masteryError)

      const { error: historyError } = await service.from('mastery_history').insert(historyInserts)
      if (historyError) console.error('[practice-quiz] mastery history insert failed', historyError)
    }
  }

  // Write result record
  const { error: resultError } = await service.from('practice_test_results').insert({
    user_id: userId,
    course_id: courseId,
    test_type: testType,
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
