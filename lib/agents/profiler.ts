import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { readWikiFile, writeWikiFile, appendToLog } from '@/lib/wiki'
import { retrieveChunks, processEmbeddings } from '@/lib/rag'
import { requireOwnedCourse } from '@/lib/authz'
import { extractText, buildVisualBlock, extractContentFromVision } from '@/lib/extract-text'
import { withRetry } from '@/lib/ai/call'
import { effectiveMastery, carryoverSeed } from '@/lib/mastery'
import { recordUsage } from '@/lib/usage'
import { log } from '@/lib/log'

// Character budgets for syllabus prompts. Previously 12k/10k chars, which silently
// dropped the tail of long syllabi — and syllabi are chronological, so the tail is
// exactly the late-semester exams/assignments the scheduler most needs. 48k chars
// ≈ 12k tokens: comfortably within Sonnet's window while bounding worst-case cost.
const SYLLABUS_EXTRACT_BUDGET = 48000
const SYLLABUS_PROFILE_BUDGET = 32000

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

type ExtractedAssignment = {
  name: string             // human-readable assignment name, e.g. "Problem Set 3"
  due_date: string         // ISO date string YYYY-MM-DD
  topics: string[]         // topic names this assignment covers (best-effort)
}

type ExtractedPrereq = {
  topic: string            // topic that depends on another
  requires: string         // the prerequisite topic
}

type ExtractedGradeCategory = {
  category: string         // e.g. "Exams", "Homework", "Participation"
  weight_pct: number       // 0–100, should roughly sum to 100
}

async function extractTopicsAndExams(
  client: Anthropic,
  userId: string,
  courseName: string,
  syllabusText: string,
  existingTopicNames: string[] = []
): Promise<{ topics: ExtractedTopic[]; exams: ExtractedExam[]; assignments: ExtractedAssignment[]; prerequisites: ExtractedPrereq[]; grading_scheme: ExtractedGradeCategory[] }> {
  const currentYear = new Date().getFullYear()

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    // 4096 (was 2048): a full semester of assignments + exams can exceed 2048
    // output tokens, truncating the JSON mid-array → parse failure → silently
    // empty extraction.
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Analyze this syllabus for "${courseName}" and extract topics, exam dates, AND assignment/homework due dates.

Return ONLY valid JSON — no other text, no markdown, no code fences.

For topics:
- Extract 8–25 main study topics (meaningful units, not every sub-bullet)
- Keep names concise (3–6 words)
- professor_weight: 0.0–1.0 reflecting how heavily this professor emphasizes this topic
  - Base this on: weeks allocated, exam percentage, explicit "important" markers, assignment frequency
  - 0.9 = major exam topic, covered extensively; 0.5 = average weight; 0.2 = brief mention only
  - Weight total across all topics should average ~0.5
${existingTopicNames.length > 0 ? `
This course ALREADY tracks these topics:
${existingTopicNames.map(n => `- ${n}`).join('\n')}
When a concept you find is the same as one above — even if phrased differently (e.g. "L'Hospital's Rule" is the same as an existing "Linear Approximation and L'Hospital"; "Mean Value Theorem" matches "Mean and Extreme Value Theorems") — REUSE the existing name EXACTLY as written above. Only output a NEW topic name for a genuinely new concept not already covered. Never create a near-duplicate of an existing topic.
` : ''}
For exams (midterms, finals, quizzes that count toward the grade):
- date: ISO format YYYY-MM-DD, assume year ${currentYear} unless a different year is obvious
- grade_weight: percentage of final grade (e.g. 30 for 30%); 0 if not stated
- duration_minutes: if stated; default 90 if not mentioned
- topics: list of topic names (from your extracted topics list) covered by this exam

For assignments (problem sets, homework, projects, papers with a DUE DATE):
- name: a short human-readable title, e.g. "Problem Set 3" or "Essay 1"
- due_date: ISO format YYYY-MM-DD, assume year ${currentYear} unless a different year is obvious. ONLY include assignments with a concrete date you can resolve — skip anything like "Week 3" or "TBD".
- topics: list of topic names (from your extracted topics list) the assignment covers (best-effort; [] if unclear)

Syllabus:
${syllabusText.slice(0, SYLLABUS_EXTRACT_BUDGET)}

For prerequisites (which topics build on which):
- Syllabi are ordered for a reason — when topic B clearly builds on topic A (derivatives→chain rule, limits→derivatives), record it
- ONLY use topic names from your extracted list (or the already-tracked list above)
- Only include CLEAR dependencies; an empty list is fine

For grading_scheme (the course grade breakdown):
- ONLY what the syllabus explicitly states (e.g. "Exams 50%, Homework 30%, Participation 20%")
- weight_pct values should sum to ~100; an empty list if no breakdown is stated

Respond with exactly:
{"topics":[{"name":"...","syllabus_order":1,"professor_weight":0.7},...],
"exams":[{"date":"2025-10-15","grade_weight":25,"duration_minutes":75,"topics":["Topic A","Topic B"]},...],
"assignments":[{"name":"Problem Set 1","due_date":"2025-09-12","topics":["Topic A"]},...],
"prerequisites":[{"topic":"Topic B","requires":"Topic A"},...],
"grading_scheme":[{"category":"Exams","weight_pct":50},...]}`,
      },
    ],
  })

  recordUsage(userId, 'profiler', 'claude-sonnet-4-6', message.usage)

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
    const assignments: ExtractedAssignment[] = Array.isArray(parsed.assignments)
      ? parsed.assignments
          .filter((a: { name?: string; due_date?: string }) =>
            typeof a.name === 'string' && a.name.trim().length > 0 &&
            typeof a.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.due_date))
          .map((a: { name: string; due_date: string; topics?: string[] }) => ({
            name: a.name.trim(),
            due_date: a.due_date,
            topics: Array.isArray(a.topics) ? a.topics : [],
          }))
      : []
    const prerequisites: ExtractedPrereq[] = Array.isArray(parsed.prerequisites)
      ? parsed.prerequisites
          .filter((p: { topic?: string; requires?: string }) =>
            typeof p.topic === 'string' && p.topic.trim().length > 0 &&
            typeof p.requires === 'string' && p.requires.trim().length > 0 &&
            p.topic.trim().toLowerCase() !== p.requires.trim().toLowerCase())
          .map((p: { topic: string; requires: string }) => ({ topic: p.topic.trim(), requires: p.requires.trim() }))
      : []
    const grading_scheme: ExtractedGradeCategory[] = Array.isArray(parsed.grading_scheme)
      ? parsed.grading_scheme
          .filter((g: { category?: string; weight_pct?: number }) =>
            typeof g.category === 'string' && g.category.trim().length > 0 &&
            typeof g.weight_pct === 'number' && g.weight_pct > 0 && g.weight_pct <= 100)
          .map((g: { category: string; weight_pct: number }) => ({
            category: g.category.trim().slice(0, 80),
            weight_pct: Math.round(g.weight_pct * 100) / 100,
          }))
          .slice(0, 12)
      : []
    return { topics, exams, assignments, prerequisites, grading_scheme }
  } catch (e) {
    console.error('[profiler] JSON parse failed. Raw response was:\n---\n' + raw.slice(0, 500) + '\n---', e)
    return { topics: [], exams: [], assignments: [], prerequisites: [], grading_scheme: [] }
  }
}

async function extractProfessorProfile(
  client: Anthropic,
  userId: string,
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
${syllabusText.slice(0, SYLLABUS_PROFILE_BUDGET)}

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

  recordUsage(userId, 'profiler', 'claude-sonnet-4-6', message.usage)

  return message.content[0].type === 'text' ? message.content[0].text.trim() : ''
}

// Tutor-recorded learning insights are appended to learning_profile.md as
// `- [YYYY-MM-DD] insight` bullets (write_wiki_pattern). The profiler rebuilds the
// file from DB state, so it MUST carry those bullets forward — previously every
// profiler re-run silently wiped all tutor-recorded memory (verified bug B3).
const TUTOR_INSIGHT_RE = /^- \[\d{4}-\d{2}-\d{2}\] /

function extractTutorInsights(existingProfile: string | null): string[] {
  if (!existingProfile) return []
  const seen = new Set<string>()
  const insights: string[] = []
  for (const raw of existingProfile.split('\n')) {
    const line = raw.trim()
    if (TUTOR_INSIGHT_RE.test(line) && !seen.has(line)) {
      seen.add(line)
      insights.push(line)
    }
  }
  return insights
}

async function buildLearningProfile(userId: string): Promise<string> {
  const service = createServiceClient()

  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const [{ data: courses }, existingProfile, { data: masteryRows }, { data: memories }, { count: recentReviews }] = await Promise.all([
    service
      .from('courses')
      .select(`
        course_id,
        name,
        professors ( name ),
        topics ( topic_id )
      `)
      .eq('user_id', userId)
      .eq('active_status', 'active'),
    readWikiFile(userId, 'learning_profile.md').catch(() => null),
    service.from('topic_mastery').select('mastery_score, last_updated, topics(name)').eq('user_id', userId),
    service.from('student_memory').select('kind, content').eq('user_id', userId).order('last_seen', { ascending: false }).limit(20),
    service.from('review_logs').select('log_id', { count: 'exact', head: true }).eq('user_id', userId).gte('reviewed_at', fourteenDaysAgo),
  ])

  const tutorInsights = extractTutorInsights(existingProfile)

  if (!courses || courses.length === 0) {
    const empty = ['# Learning Profile', '', '*No courses enrolled yet.*', '']
    if (tutorInsights.length > 0) empty.push('## Observed Patterns', '', ...tutorInsights, '')
    return empty.join('\n')
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

  // M12: synthesize from REAL data (this section previously shipped literal
  // placeholder text — "*Will be updated as you study.*" — forever).
  type ProfMasteryRow = { mastery_score: number | null; last_updated: string | null; topics: { name: string } | null }
  const ranked = ((masteryRows ?? []) as ProfMasteryRow[])
    .filter(m => m.topics)
    .map(m => ({ name: m.topics!.name, eff: effectiveMastery(m.mastery_score, m.last_updated) }))
    .sort((a, b) => b.eff - a.eff)

  const strengths = ranked.filter(t => t.eff >= 0.55).slice(0, 4)
  const struggles = [...ranked].reverse().filter(t => t.eff < 0.45 && t.eff > 0).slice(0, 4)
  lines.push('## Strengths')
  lines.push(strengths.length > 0
    ? strengths.map(t => `- ${t.name} (${Math.round(t.eff * 100)}%)`).join('\n')
    : '*No demonstrated strengths yet — they appear as mastery builds.*')
  lines.push('')
  if (struggles.length > 0) {
    lines.push('## Working on', struggles.map(t => `- ${t.name} (${Math.round(t.eff * 100)}%)`).join('\n'), '')
  }

  const prefs = ((memories ?? []) as { kind: string; content: string }[]).filter(m => m.kind === 'preference').slice(0, 5)
  const misconceptions = ((memories ?? []) as { kind: string; content: string }[]).filter(m => m.kind === 'misconception').slice(0, 5)
  lines.push('## Study Preferences')
  lines.push(prefs.length > 0 ? prefs.map(p => `- ${p.content}`).join('\n') : '*None recorded yet.*')
  lines.push('')
  if (misconceptions.length > 0) {
    lines.push('## Recurring misconceptions', misconceptions.map(m => `- ${m.content}`).join('\n'), '')
  }
  lines.push('## Study cadence', `- ${recentReviews ?? 0} card reviews in the last 14 days`, '')

  if (tutorInsights.length > 0) {
    lines.push('## Observed Patterns', '', ...tutorInsights, '')
  }

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
  opts?: {
    // Embed the syllabus text for RAG after extraction. Set by the syllabus-insert
    // paths (onboarding/complete, courses/create, profiler/rerun) which previously
    // never embedded tier-1 materials at all (verified bug B1) — the richest course
    // document was invisible to retrieval. The inbox path embeds separately and
    // must NOT set this (it would double-embed).
    embed?: boolean
  },
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
  const client = new Anthropic({ apiKey })

  // Shared extraction (same module the inbox classifier uses) including the vision
  // fallback for scanned/image-only PDFs — previously the profiler had no OCR path,
  // so a scanned syllabus silently produced zero topics (verified bug B8).
  const extracted = await extractText(buffer, material.file_type ?? '', material.filename ?? '')
  let syllabusText = extracted.text

  if (extracted.isImagePdf || extracted.isImageFile) {
    const visualBlock = await buildVisualBlock(buffer, extracted)
    if (visualBlock) {
      const visionText = await extractContentFromVision(client, visualBlock)
      if (visionText.trim().length >= 50) {
        syllabusText = visionText
      }
    }
  }

  if (syllabusText.trim().length < 50) {
    console.error(`${tag} syllabus text too short (${syllabusText.length} chars) — skipping`)
    return
  }

  // Embed the syllabus for RAG (B1). Non-fatal: profiling proceeds even if the
  // user has no OpenAI key (processEmbeddings stores keyword-searchable chunks).
  if (opts?.embed) {
    await processEmbeddings(userId, materialId, syllabusText).catch(e =>
      console.error(`${tag} processEmbeddings failed (non-fatal)`, e)
    )
  }

  // Load already-tracked topics FIRST so the extractor can reuse their canonical
  // names instead of inventing near-duplicates (the exact-name dedup below missed
  // "L'Hospital" vs "LHopitals Rule"). The model does the semantic merge — no false
  // positives the way fuzzy string matching would have.
  const { data: existingTopics } = await service
    .from('topics')
    .select('topic_id, name')
    .eq('course_id', courseId)
    .eq('user_id', userId)
  const existingTopicNames: string[] = (existingTopics ?? []).map((t: { name: string }) => t.name)

  const extractedTopics: ExtractedTopic[] = []
  const extractedExams: ExtractedExam[] = []
  const extractedAssignments: ExtractedAssignment[] = []

  // I6: process the WHOLE syllabus in windows (up to 3 × budget ≈ 144k chars)
  // instead of one truncated slice — syllabi are chronological, so truncation
  // dropped exactly the late-semester exams/assignments the scheduler most
  // needs. Each window sees the topic names accumulated so far for dedup.
  const windows: string[] = []
  const STEP = SYLLABUS_EXTRACT_BUDGET - 2000 // overlap so a row split across windows isn't lost
  for (let i = 0; i < syllabusText.length && windows.length < 3; i += STEP) {
    windows.push(syllabusText.slice(i, i + SYLLABUS_EXTRACT_BUDGET))
  }

  const namesSoFar = [...existingTopicNames]
  const seenExamDates = new Set<string>()
  const seenAssignmentKeys = new Set<string>()
  const extractedPrereqs: ExtractedPrereq[] = []
  const seenPrereqKeys = new Set<string>()
  let extractedScheme: ExtractedGradeCategory[] = []
  // Every model-emitted weight, INCLUDING for already-tracked topics — the
  // dedup filter below excludes existing topics from extractedTopics, so the
  // weight-refresh step must read from here or re-runs never update weights.
  const latestWeightByName = new Map<string, number>()
  // Windows each emit syllabus_order starting at 1 — renumber globally in
  // emission order so a long syllabus doesn't interleave topics from window 2
  // into window 1's ordering.
  const orderBase = existingTopicNames.length
  try {
    for (const window of windows) {
      // withRetry (R1): a transient 529/overload previously made the profiler
      // "succeed" with zero topics; also records key health on auth failures (R5).
      const result = await withRetry(
        () => extractTopicsAndExams(client, userId, courseName, window, namesSoFar),
        { label: 'profiler.extract', keyHealth: { userId, provider: 'anthropic' } },
      )
      for (const t of result.topics) {
        latestWeightByName.set(t.name.toLowerCase(), t.professor_weight)
        if (!namesSoFar.some(n => n.toLowerCase() === t.name.toLowerCase())) {
          extractedTopics.push({ ...t, syllabus_order: orderBase + extractedTopics.length + 1 })
          namesSoFar.push(t.name)
        }
      }
      for (const e of result.exams) {
        if (!seenExamDates.has(e.date)) {
          seenExamDates.add(e.date)
          extractedExams.push(e)
        }
      }
      for (const a of result.assignments) {
        const key = `${a.name.toLowerCase()}|${a.due_date}`
        if (!seenAssignmentKeys.has(key)) {
          seenAssignmentKeys.add(key)
          extractedAssignments.push(a)
        }
      }
      for (const p of result.prerequisites) {
        const key = `${p.topic.toLowerCase()}->${p.requires.toLowerCase()}`
        if (!seenPrereqKeys.has(key)) {
          seenPrereqKeys.add(key)
          extractedPrereqs.push(p)
        }
      }
      // Grading scheme usually lives on page 1 — keep the first non-empty one.
      if (extractedScheme.length === 0 && result.grading_scheme.length > 0) {
        extractedScheme = result.grading_scheme
      }
    }
  } catch (e) {
    console.error(`${tag} Claude call failed`, e)
    if (extractedTopics.length === 0) return // nothing extracted at all — give up
    // Partial extraction (a later window failed): proceed with what we have.
  }

  // Dedupe against existing topics (now a safety net — the extractor reuses existing
  // names, so an exact-name match correctly merges instead of duplicating).
  const existingNames = new Set(existingTopicNames.map(n => n.toLowerCase()))
  const newTopics = extractedTopics.filter(t => !existingNames.has(t.name.toLowerCase()))

  // Update professor_weight on existing topics that match by name — issue in
  // parallel. Reads from latestWeightByName (NOT extractedTopics, which by
  // design excludes existing topics — reading it left weights stale forever).
  const weightUpdates = (existingTopics ?? [])
    .map((existing: { topic_id: string; name: string }) => {
      const w = latestWeightByName.get(existing.name.toLowerCase())
      return w !== undefined ? { topic_id: existing.topic_id, professor_weight: w } : null
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

  // S1: persist the grading scheme (category weights) so the grade tracker can
  // compute "what do I need on the final". Upsert: a syllabus re-upload
  // refreshes weights without duplicating categories.
  if (extractedScheme.length > 0) {
    const { error: schemeError } = await service
      .from('course_grade_schemes')
      .upsert(
        extractedScheme.map(g => ({
          user_id: userId,
          course_id: courseId,
          category: g.category,
          weight_pct: g.weight_pct,
        })),
        { onConflict: 'user_id,course_id,category' }
      )
    if (schemeError) console.error(`${tag} grade scheme upsert failed`, schemeError)
  }

  let insertedTopics: { topic_id: string; name: string }[] = []

  if (newTopics.length > 0) {
    // Upsert with ignoreDuplicates (ON CONFLICT DO NOTHING on the
    // topics_user_course_name_uniq index): two concurrent profiler runs read the
    // same existing-topics snapshot, so both try to insert the same "new" topics —
    // previously a duplicate-row race (verified bug B12). The loser's rows are
    // skipped; its mastery seeding is covered by the winner.
    const { data, error: topicInsertError } = await service
      .from('topics')
      .upsert(
        newTopics.map(t => ({
          course_id: courseId,
          user_id: userId,
          name: t.name,
          syllabus_order: t.syllabus_order,
          professor_weight: t.professor_weight,
        })),
        { onConflict: 'user_id,course_id,name', ignoreDuplicates: true }
      )
      .select('topic_id, name')

    if (topicInsertError) {
      console.error(`${tag} topic insert failed`, topicInsertError)
      return
    }

    insertedTopics = (data ?? []) as { topic_id: string; name: string }[]

    if (insertedTopics.length > 0) {
      // S9: mastery carryover — a topic matching one the student already built
      // mastery on in ANOTHER course (e.g. "Limits Review" in Calc II after
      // Calc I) seeds at a discounted fraction of the time-decayed prior
      // instead of zero, so spaced repetition warm-starts and the scheduler
      // doesn't treat known material as a cold gap.
      const { data: priorRows } = await service
        .from('topic_mastery')
        .select('mastery_score, last_updated, topics!inner(name, course_id)')
        .eq('user_id', userId)
        .neq('topics.course_id', courseId)
      const priorTopics = ((priorRows ?? []) as unknown as { mastery_score: number | null; last_updated: string | null; topics: { name: string } }[])
        .filter(r => r.topics?.name)
        .map(r => ({ name: r.topics.name, eff: effectiveMastery(r.mastery_score, r.last_updated) }))

      let carried = 0
      await service.from('topic_mastery').upsert(
        insertedTopics.map((t: { topic_id: string; name: string }) => {
          const seed = priorTopics.length > 0 ? carryoverSeed(t.name, priorTopics) : null
          if (seed !== null) carried++
          return {
            user_id: userId,
            topic_id: t.topic_id,
            mastery_score: seed ?? 0,
            confidence: seed !== null ? 0.1 : 0,
          }
        }),
        { onConflict: 'user_id,topic_id', ignoreDuplicates: true }
      )
      if (carried > 0) log.debug(`${tag} carried over prior mastery for ${carried}/${insertedTopics.length} topics (S9)`)
    }
  }

  // Re-read the authoritative topic set: under the B12 concurrent-run race,
  // upsert ignoreDuplicates RETURNING omits rows the OTHER run inserted first,
  // so the snapshot+insertedTopics union can miss freshly-created topics and
  // silently drop prereq edges / exam topic links.
  let resolvedTopics = [
    ...(existingTopics ?? []),
    ...insertedTopics,
  ] as { topic_id: string; name: string }[]
  if (extractedPrereqs.length > 0 || extractedExams.length > 0) {
    const { data: allCourseTopics } = await service
      .from('topics')
      .select('topic_id, name')
      .eq('course_id', courseId)
      .eq('user_id', userId)
    if (allCourseTopics && allCourseTopics.length > 0) {
      resolvedTopics = allCourseTopics as { topic_id: string; name: string }[]
    }
  }

  // I5: persist the prerequisite edges (topic names → ids over the
  // authoritative set). Drives "fix the foundation first" in the tutor
  // and a scheduler boost for weak prerequisites.
  if (extractedPrereqs.length > 0) {
    const byName = new Map(resolvedTopics.map(t => [t.name.toLowerCase(), t.topic_id]))
    const edges = extractedPrereqs
      .map(p => ({ topic_id: byName.get(p.topic.toLowerCase()), prereq_topic_id: byName.get(p.requires.toLowerCase()) }))
      .filter((e): e is { topic_id: string; prereq_topic_id: string } => !!e.topic_id && !!e.prereq_topic_id && e.topic_id !== e.prereq_topic_id)
      .map(e => ({ ...e, user_id: userId, course_id: courseId }))
    if (edges.length > 0) {
      const { error: prereqError } = await service
        .from('topic_prerequisites')
        .upsert(edges, { onConflict: 'topic_id,prereq_topic_id', ignoreDuplicates: true })
      if (prereqError) console.error(`${tag} prerequisite insert failed`, prereqError)
    }
  }

  // Insert extracted exam dates into the exams table
  if (extractedExams.length > 0) {
    const allTopics = resolvedTopics

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

  // Insert extracted assignment/homework due dates. This is what lets a single
  // syllabus upload populate the WHOLE semester's coursework (not just exams), so
  // the Today plan knows about recurring homework. Future-dated only (never create a
  // past-due wall), deduped by name + due_date.
  if (extractedAssignments.length > 0) {
    const todayKey = new Date().toISOString().split('T')[0]
    const futureAssignments = extractedAssignments.filter(a => a.due_date >= todayKey)

    if (futureAssignments.length > 0) {
      const { data: existingAssignmentRows } = await service
        .from('assignments')
        .select('name, due_date')
        .eq('course_id', courseId)
        .eq('user_id', userId)

      const existingKeys = new Set(
        // name is nullable — coalesce like the SQL dedup does so a null-name
        // row can't throw here.
        ((existingAssignmentRows ?? []) as { name: string | null; due_date: string }[])
          .map(r => `${(r.name ?? '').toLowerCase()}|${r.due_date.slice(0, 10)}`)
      )

      const assignmentRowsToInsert = futureAssignments
        .filter(a => !existingKeys.has(`${a.name.toLowerCase()}|${a.due_date}`))
        .map(a => ({
          course_id: courseId,
          user_id: userId,
          name: a.name,
          due_date: a.due_date,
          type: 'homework',
          completion_status: 'pending',
        }))

      if (assignmentRowsToInsert.length > 0) {
        // ignoreDuplicates on assignments_user_course_name_due_uniq: concurrent
        // profiler runs (or a re-run racing the first) can't accrete duplicate
        // assignment rows (B12).
        const { error: assignmentInsertError } = await service
          .from('assignments')
          .upsert(assignmentRowsToInsert, { onConflict: 'user_id,course_id,name,due_date', ignoreDuplicates: true })
        if (assignmentInsertError) console.error(`${tag} assignment batch insert failed`, assignmentInsertError)
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
      professorProfile = await withRetry(
        () => extractProfessorProfile(client, userId, professorName, courseName, enrichedSyllabus, existing),
        { label: 'profiler.professor', keyHealth: { userId, provider: 'anthropic' } },
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
