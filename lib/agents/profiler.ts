import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { readWikiFile, writeWikiFile, appendToLog } from '@/lib/wiki'
import { retrieveChunks } from '@/lib/rag'
import { requireOwnedCourse } from '@/lib/authz'

type ExtractedTopic = {
  name: string
  syllabus_order: number
  professor_weight: number  // 0.0–1.0: how heavily this topic is emphasized
}

type ExtractedExam = {
  date: string             // ISO date string YYYY-MM-DD
  grade_weight: number     // 0–100 (percentage of final grade)
  duration_minutes: number // estimated exam duration
  topics: string[]         // topic names covered (matched against extracted topics)
}

async function extractTopicsAndExams(
  client: Anthropic,
  courseName: string,
  syllabusText: string
): Promise<{ topics: ExtractedTopic[]; exams: ExtractedExam[] }> {
  const currentYear = new Date().getFullYear()

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Analyze this syllabus for "${courseName}" and extract topics AND exam dates.

Return ONLY valid JSON — no other text, no markdown, no code fences.

For topics:
- Extract 8–25 main study topics (meaningful units, not every sub-bullet)
- Keep names concise (3–6 words)
- professor_weight: 0.0–1.0 reflecting how heavily this professor emphasizes this topic
  - Base this on: weeks allocated, exam percentage, explicit "important" markers, assignment frequency
  - 0.9 = major exam topic, covered extensively; 0.5 = average weight; 0.2 = brief mention only
  - Weight total across all topics should average ~0.5

For exams (midterms, finals, quizzes that count toward the grade):
- date: ISO format YYYY-MM-DD, assume year ${currentYear} unless a different year is obvious
- grade_weight: percentage of final grade (e.g. 30 for 30%); 0 if not stated
- duration_minutes: if stated; default 90 if not mentioned
- topics: list of topic names (from your extracted topics list) covered by this exam

Syllabus:
${syllabusText.slice(0, 12000)}

Respond with exactly:
{"topics":[{"name":"...","syllabus_order":1,"professor_weight":0.7},...],
"exams":[{"date":"2025-10-15","grade_weight":25,"duration_minutes":75,"topics":["Topic A","Topic B"]},...]}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  const match = cleaned.match(/\{[\s\S]*\}/)
  const candidate = match ? match[0] : cleaned

  try {
    const parsed = JSON.parse(candidate)
    const topics: ExtractedTopic[] = Array.isArray(parsed.topics)
      ? parsed.topics.map((t: { name: string; syllabus_order: number; professor_weight?: number }) => ({
          name: t.name,
          syllabus_order: t.syllabus_order,
          professor_weight: typeof t.professor_weight === 'number'
            ? Math.max(0, Math.min(1, t.professor_weight))
            : 0.5,
        }))
      : []
    const exams: ExtractedExam[] = Array.isArray(parsed.exams)
      ? parsed.exams.filter((e: { date?: string }) => e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      : []
    return { topics, exams }
  } catch (e) {
    console.error('[profiler] JSON parse failed. Raw response was:\n---\n' + raw.slice(0, 500) + '\n---', e)
    return { topics: [], exams: [] }
  }
}

async function extractProfessorProfile(
  client: Anthropic,
  professorName: string,
  courseName: string,
  syllabusText: string,
  existingWiki: string | null,
): Promise<string> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are building a professor profile wiki file for a student's AI study system.

Professor: ${professorName}
Course: ${courseName}
${existingWiki ? `\nExisting profile (update and expand, do not lose data):\n${existingWiki}\n` : ''}
Syllabus:
${syllabusText.slice(0, 10000)}

Extract everything that reveals this professor's patterns, priorities, and style. Write a concise markdown wiki file covering:

1. **Grading breakdown** — exact weights if listed (exams, homework, participation, etc.)
2. **Exam style** — number of exams, format (MC, short answer, essay, problems), any stated policies
3. **Topic emphasis** — which topics get the most coverage or grade weight
4. **Stated policies** — late work, attendance, collaboration, make-up exams
5. **Teaching style signals** — anything revealing about how this professor approaches the subject

Be specific and factual — only write what the syllabus actually says. Do not invent patterns. Use markdown headers. Keep it under 400 words.`,
      },
    ],
  })

  return message.content[0].type === 'text' ? message.content[0].text.trim() : ''
}

async function buildLearningProfile(userId: string): Promise<string> {
  const service = createServiceClient()

  const { data: courses } = await service
    .from('courses')
    .select(`
      course_id,
      name,
      professors ( name ),
      topics ( topic_id )
    `)
    .eq('user_id', userId)
    .eq('active_status', 'active')

  if (!courses || courses.length === 0) {
    return `# Learning Profile\n\n*No courses enrolled yet.*\n`
  }

  const lines = ['# Learning Profile', '', '## Enrolled Courses', '']
  for (const course of courses) {
    const profName = Array.isArray(course.professors)
      ? (course.professors[0] as { name: string } | undefined)?.name ?? 'Unknown'
      : (course.professors as { name: string } | null)?.name ?? 'Unknown'
    const topicCount = Array.isArray(course.topics) ? course.topics.length : 0
    lines.push(`### ${course.name}`)
    lines.push(`- Professor: ${profName}`)
    lines.push(`- Topics extracted: ${topicCount}`)
    lines.push('')
  }

  lines.push('## Strengths', '*Will be updated as you study.*', '')
  lines.push('## Study Preferences', '*Derived from session history over time.*', '')

  return lines.join('\n')
}

async function buildWeakAreas(userId: string): Promise<string> {
  const service = createServiceClient()

  const { data: mastery } = await service
    .from('topic_mastery')
    .select(`
      mastery_score,
      topics ( name, courses ( name ) )
    `)
    .eq('user_id', userId)
    .order('mastery_score', { ascending: true })
    .limit(20)

  const lines = ['# Weak Areas', '', '*Updated by the Profiler Agent after each study session.*', '']

  if (!mastery || mastery.length === 0) {
    lines.push('No mastery data yet. Topics will appear here as you study.')
    return lines.join('\n')
  }

  for (const row of mastery) {
    const topic = row.topics as { name: string; courses: { name: string } | null } | null
    if (!topic) continue
    const score = Math.round((row.mastery_score ?? 0) * 100)
    const course = topic.courses?.name ?? 'Unknown course'
    lines.push(`- **${topic.name}** (${course}) — ${score}% mastery`)
  }

  return lines.join('\n')
}

export async function runProfiler(
  userId: string,
  materialId: string,
  courseId: string,
  courseName: string,
): Promise<void> {
  const tag = `[profiler ${courseName}]`
  const service = createServiceClient()
  const ownedCourse = await requireOwnedCourse(userId, courseId)
  if (!ownedCourse) {
    console.error(`${tag} course ownership check failed`)
    return
  }

  const apiKey = await getUserApiKey(userId)
  if (!apiKey) {
    console.error(`${tag} no API key in vault for user ${userId}`)
    return
  }

  const { data: material, error: materialError } = await service
    .from('materials')
    .select('storage_path, filename, file_type')
    .eq('material_id', materialId)
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .single()

  if (materialError || !material?.storage_path) {
    console.error(`${tag} material lookup failed`, materialError)
    return
  }

  const { data: fileData, error: dlError } = await service.storage
    .from('materials')
    .download(material.storage_path)

  if (dlError || !fileData) {
    console.error(`${tag} storage download failed for ${material.storage_path}`, dlError)
    return
  }

  const buffer = Buffer.from(await fileData.arrayBuffer())
  let syllabusText = ''

  if (material.file_type === 'pdf') {
    try {
      // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse')
      const parsed = await pdfParse(buffer)
      syllabusText = parsed.text
    } catch (e) {
      console.error(`${tag} pdf-parse failed, falling back to utf-8`, e)
      syllabusText = buffer.toString('utf-8')
    }
  } else {
    syllabusText = buffer.toString('utf-8')
  }

  if (syllabusText.trim().length < 50) {
    console.error(`${tag} syllabus text too short (${syllabusText.length} chars) — skipping`)
    return
  }

  const client = new Anthropic({ apiKey })
  let extractedTopics: ExtractedTopic[] = []
  let extractedExams: ExtractedExam[] = []

  try {
    const result = await extractTopicsAndExams(client, courseName, syllabusText)
    extractedTopics = result.topics
    extractedExams = result.exams
  } catch (e) {
    console.error(`${tag} Claude call failed`, e)
    return
  }

  // Deduplicate against existing topics
  const { data: existingTopics } = await service
    .from('topics')
    .select('topic_id, name')
    .eq('course_id', courseId)
    .eq('user_id', userId)

  const existingNames = new Set((existingTopics ?? []).map((t: { name: string }) => t.name.toLowerCase()))
  const newTopics = extractedTopics.filter(t => !existingNames.has(t.name.toLowerCase()))

  // Update professor_weight on existing topics that match by name — issue in parallel
  const weightUpdates = (existingTopics ?? [])
    .map((existing: { topic_id: string; name: string }) => {
      const match = extractedTopics.find(t => t.name.toLowerCase() === existing.name.toLowerCase())
      return match ? { topic_id: existing.topic_id, professor_weight: match.professor_weight } : null
    })
    .filter(Boolean) as { topic_id: string; professor_weight: number }[]

  if (weightUpdates.length > 0) {
    await Promise.all(
      weightUpdates.map(u =>
        service.from('topics').update({ professor_weight: u.professor_weight }).eq('topic_id', u.topic_id)
          .eq('user_id', userId)
      )
    )
  }

  let insertedTopics: { topic_id: string; name: string }[] = []

  if (newTopics.length > 0) {
    const { data, error: topicInsertError } = await service
      .from('topics')
      .insert(
        newTopics.map(t => ({
          course_id: courseId,
          user_id: userId,
          name: t.name,
          syllabus_order: t.syllabus_order,
          professor_weight: t.professor_weight,
        }))
      )
      .select('topic_id, name')

    if (topicInsertError) {
      console.error(`${tag} topic insert failed`, topicInsertError)
      return
    }

    insertedTopics = (data ?? []) as { topic_id: string; name: string }[]

    if (insertedTopics.length > 0) {
      await service.from('topic_mastery').insert(
        insertedTopics.map((t: { topic_id: string }) => ({
          user_id: userId,
          topic_id: t.topic_id,
          mastery_score: 0,
          confidence: 0,
        }))
      )
    }
  }

  // Insert extracted exam dates into the exams table
  if (extractedExams.length > 0) {
    const allTopics = [
      ...(existingTopics ?? []),
      ...insertedTopics,
    ] as { topic_id: string; name: string }[]

    const today = new Date().toISOString().split('T')[0]
    const futureExams = extractedExams.filter(e => e.date >= today)

    if (futureExams.length > 0) {
      // One query for all existing exam dates on this course, then batch insert the rest.
      const { data: existingExamRows } = await service
        .from('exams')
        .select('date')
        .eq('course_id', courseId)
        .eq('user_id', userId)
        .in('date', futureExams.map(e => e.date))

      const existingDates = new Set(((existingExamRows ?? []) as { date: string }[]).map(r => r.date))

      const examRowsToInsert = futureExams
        .filter(exam => !existingDates.has(exam.date))
        .map(exam => {
          const topicIds = exam.topics
            .map(name => allTopics.find((t: { name: string }) => t.name.toLowerCase() === name.toLowerCase())?.topic_id)
            .filter(Boolean) as string[]
          return {
            course_id: courseId,
            user_id: userId,
            date: exam.date,
            grade_weight: exam.grade_weight > 0 ? exam.grade_weight : null,
            duration_minutes: exam.duration_minutes > 0 ? exam.duration_minutes : null,
            topics_covered: topicIds.length > 0 ? topicIds : null,
          }
        })

      if (examRowsToInsert.length > 0) {
        const { error: examInsertError } = await service.from('exams').insert(examRowsToInsert)
        if (examInsertError) console.error(`${tag} exam batch insert failed`, examInsertError)
      }
    }
  }

  // Fetch professor info for this course
  const { data: courseRow } = await service
    .from('courses')
    .select('professor_id, professors ( name )')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .single()

  const professorId = courseRow?.professor_id as string | null
  const professorName = professorId
    ? (Array.isArray(courseRow?.professors)
        ? (courseRow.professors[0] as { name: string } | undefined)?.name
        : (courseRow?.professors as { name: string } | null)?.name) ?? null
    : null

  // Build professor wiki from syllabus + any other course material via RAG
  let professorWikiWrite: Promise<void> | null = null
  if (professorId && professorName) {
    const wikiFilename = `professor_${professorId}.md`
    const existing = await readWikiFile(userId, wikiFilename)

    const ragChunks = await retrieveChunks(
      `${professorName} exam style grading topics emphasis`,
      courseId,
      userId,
      4
    ).catch(() => [])

    const additionalContext = ragChunks.length > 0
      ? `\nAdditional course material excerpts:\n${ragChunks.map(c => c.content).join('\n\n---\n\n')}`
      : ''

    const enrichedSyllabus = syllabusText + additionalContext

    let professorProfile = ''
    try {
      professorProfile = await extractProfessorProfile(
        client,
        professorName,
        courseName,
        enrichedSyllabus,
        existing,
      )
    } catch (e) {
      console.error(`${tag} extractProfessorProfile failed`, e)
    }
    if (professorProfile) {
      professorWikiWrite = writeWikiFile(userId, wikiFilename, professorProfile, 'profiler')
        .catch(e => console.error(`${tag} writeWikiFile failed`, e))
    }
  }

  // Update general wiki
  const [profile, weakAreas] = await Promise.all([
    buildLearningProfile(userId),
    buildWeakAreas(userId),
  ])

  await Promise.all([
    writeWikiFile(userId, 'learning_profile.md', profile, 'profiler'),
    writeWikiFile(userId, 'weak_areas.md', weakAreas, 'profiler'),
    appendToLog(userId, `Profiler extracted ${newTopics.length} topics (weights set) + ${extractedExams.length} exam dates from "${material.filename}" for ${courseName}${professorName ? ` · updated ${professorName}'s profile` : ''}`),
    ...(professorWikiWrite ? [professorWikiWrite] : []),
  ])
}
