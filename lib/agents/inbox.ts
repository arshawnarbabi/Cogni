import Anthropic from '@anthropic-ai/sdk'
import type { DocumentBlockParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { appendToLog } from '@/lib/wiki'
import { requireOwnedCourse } from '@/lib/authz'
import { consumeAiQuota } from '@/lib/rate-limit'
import { extractText, buildVisualBlock, extractContentFromVision } from '@/lib/extract-text'
import { withRetry } from '@/lib/ai/call'
import { enqueueJob, kickJobs } from '@/lib/jobs'

// Embedding text rides in the job payload (the vision-extracted transcription is
// not cheaply re-derivable in the worker). Cap to bound jsonb row size.
const EMBED_PAYLOAD_CAP = 250_000

type ClassifyResult = {
  courseId: string | null
  tier: number
  status: 'classified' | 'unassigned' | 'failed' | 'unreadable'
  isHomework: boolean
  dueDate: string | null
  dismissed?: boolean
  gradeSuggested?: boolean
}

// A grade candidate the classifier read off returned, graded work (F1). Only
// produced when BOTH the earned score and the total are determinable — a
// "84/?" is too low-confidence to surface, so we skip it rather than guess.
type GradeCandidate = {
  pointsEarned: number
  pointsPossible: number
  name: string | null
  categoryGuess: string | null
}

const CLASSIFY_PROMPT = (courseList: string, filename: string, context: string | undefined, content: string) =>
  `You are classifying a student document. Return ONLY valid JSON, no other text.

Student's courses:
${courseList || '(no courses)'}

Document filename: ${filename}
${context ? `User context: ${context}\n` : ''}${content ? `Document content (first 12000 chars):\n${content}` : '(no text content — classify from visual content only)'}

Classify this document:
1. is_context_hint: true if this is a label, description, or meta-note about files/content rather than actual course material itself. Examples that ARE context hints: "These are my notes for calculus", "Here are my physics homeworks", "This is my syllabus", "Uploading calc stuff". Examples that are NOT context hints: actual lecture notes, problem sets, textbook pages, syllabuses with real content. If the entire content is just one or two sentences describing what something is, it is a context hint.
2. course_id: which course_id from the list above, or null if none match
3. tier: 1=syllabus/course overview, 2=primary material (lecture notes, textbook), 3=supplementary (practice problems, past exams), 4=misc/unclear
4. is_homework: true only if this document contains actual homework problems or assignments a student must complete and submit — false otherwise. A sentence mentioning the word "homework" is NOT homework unless it contains the actual assignment content.
5. due_date: if is_homework is true, extract the due date as "YYYY-MM-DD", or null if not mentioned
6. graded_work: ONLY if this is RETURNED, GRADED work that shows the student's earned score (a number out of a total, or a percentage written on it). NOT a blank assignment, an answer key, or ungraded material.
   - is_graded: true only when there is a clear earned score on the page
   - points_earned and points_possible: the score, e.g. 84 and 100. If only a percentage is shown (e.g. "84%"), use points_earned 84 and points_possible 100. BOTH must be determinable — if you cannot determine the total, set is_graded false.
   - assessment_name: a short title like "Midterm 1" or "Problem Set 3", or null
   - category_guess: the grade category it belongs to (e.g. "Exams", "Homework", "Quizzes"), or null

Respond with exactly: {"is_context_hint":<true|false>,"course_id":"<uuid or null>","tier":<1-4>,"is_homework":<true|false>,"due_date":"<YYYY-MM-DD or null>","is_graded":<true|false>,"points_earned":<number or null>,"points_possible":<number or null>,"assessment_name":"<string or null>","category_guess":"<string or null>"}`

export function parseClassifyResponse(raw: string): { isContextHint: boolean; courseId: string | null; tier: number; isHomework: boolean; dueDate: string | null; grade: GradeCandidate | null } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  const candidate = match ? match[0] : cleaned
  try {
    const parsed = JSON.parse(candidate)
    // F1: only accept a grade candidate when it's flagged graded AND both the
    // earned score and a positive total parsed as finite numbers.
    const earned = Number(parsed.points_earned)
    const possible = Number(parsed.points_possible)
    const grade: GradeCandidate | null =
      parsed.is_graded === true && Number.isFinite(earned) && earned >= 0 && Number.isFinite(possible) && possible > 0
        ? {
            pointsEarned: earned,
            pointsPossible: possible,
            name: typeof parsed.assessment_name === 'string' && parsed.assessment_name.trim() ? parsed.assessment_name.trim().slice(0, 200) : null,
            categoryGuess: typeof parsed.category_guess === 'string' && parsed.category_guess.trim() ? parsed.category_guess.trim().slice(0, 80) : null,
          }
        : null
    return {
      isContextHint: parsed.is_context_hint === true,
      courseId: parsed.course_id ?? null,
      tier: typeof parsed.tier === 'number' ? Math.max(1, Math.min(4, parsed.tier)) : 4,
      isHomework: parsed.is_homework === true,
      dueDate: typeof parsed.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date) ? parsed.due_date : null,
      grade,
    }
  } catch {
    return { isContextHint: false, courseId: null, tier: 4, isHomework: false, dueDate: null, grade: null }
  }
}

export async function classifyMaterial(
  userId: string,
  materialId: string,
  storagePath: string,
  filename: string,
  fileType: string,
  context?: string,
  forceCourseId?: string,
): Promise<ClassifyResult> {
  const service = createServiceClient()

  await service
    .from('materials')
    .update({ processing_status: 'processing' })
    .eq('material_id', materialId)
    .eq('user_id', userId)

  const apiKey = await getUserApiKey(userId)
  if (!apiKey) {
    await service.from('materials').update({ processing_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
    await service.from('inbox_items').update({ classification_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
    return { courseId: null, tier: 4, status: 'failed', isHomework: false, dueDate: null }
  }

  const { data: courses } = await service
    .from('courses')
    .select('course_id, name')
    .eq('user_id', userId)
    .eq('active_status', 'active')

  const { data: fileData, error: downloadError } = await service.storage
    .from('materials')
    .download(storagePath)

  if (downloadError || !fileData) {
    await service.from('materials').update({ processing_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
    await service.from('inbox_items').update({ classification_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
    return { courseId: null, tier: 4, status: 'failed', isHomework: false, dueDate: null }
  }

  const buffer = Buffer.from(await fileData.arrayBuffer())
  const { text: fullContent, isImagePdf, isImageFile, imageMimeType } = await extractText(buffer, fileType, filename)
  const content = fullContent.slice(0, 12000)
  const needsVision = isImagePdf || isImageFile

  const courseList = (courses ?? []).map((c: { course_id: string; name: string }) => `- ${c.name} (id: ${c.course_id})`).join('\n')

  // If course is pre-assigned (uploaded directly to a course), skip classification
  if (forceCourseId) {
    const ownedCourse = await requireOwnedCourse(userId, forceCourseId)
    if (!ownedCourse) {
      await service.from('materials').update({ processing_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
      await service.from('inbox_items').update({ classification_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
      return { courseId: null, tier: 4, status: 'failed', isHomework: false, dueDate: null }
    }
    await service.from('materials').update({ processing_status: 'processed', course_id: forceCourseId, tier: null }).eq('material_id', materialId).eq('user_id', userId)
    await service.from('inbox_items').update({ classification_status: 'classified', course_id: forceCourseId, tier: null }).eq('material_id', materialId).eq('user_id', userId)
    await appendToLog(userId, `Inbox: "${filename}" assigned directly to course ${forceCourseId}`)
    if (fullContent.length > 100) {
      // Durable job (F1): previously an awaited inline call — a throw lost the
      // embeddings with no retry. Drained post-response + swept by cron.
      await enqueueJob(userId, 'embed', { subjectId: materialId, payload: { text: fullContent.slice(0, EMBED_PAYLOAD_CAP) } })
      kickJobs()
    }
    return { courseId: forceCourseId, tier: 4, status: 'classified', isHomework: false, dueDate: null }
  }

  const client = new Anthropic({ apiKey })

  let rawResponse: string
  const visualBlock: DocumentBlockParam | ImageBlockParam | null = await buildVisualBlock(buffer, {
    text: fullContent, isImagePdf, isImageFile, imageMimeType,
  })

  if (needsVision && visualBlock) {
    try {
      const textBlock: TextBlockParam = {
        type: 'text',
        text: CLASSIFY_PROMPT(courseList, filename, context, ''),
      }
      const visionMessage = await withRetry(
        () => client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 640,
          messages: [{ role: 'user', content: [visualBlock, textBlock] }],
        }),
        { label: 'inbox.classify.vision', keyHealth: { userId, provider: 'anthropic' } },
      )
      rawResponse = visionMessage.content[0].type === 'text' ? visionMessage.content[0].text : ''
    } catch (e) {
      console.error('[inbox] vision classification failed', e)
      await service.from('materials').update({ processing_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
      await service.from('inbox_items').update({ classification_status: 'unreadable' }).eq('material_id', materialId).eq('user_id', userId)
      await appendToLog(userId, `Inbox: "${filename}" marked unreadable — vision failed`)
      return { courseId: null, tier: 4, status: 'unreadable', isHomework: false, dueDate: null }
    }
  } else {
    const message = await withRetry(
      () => client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 640,
        messages: [{ role: 'user', content: CLASSIFY_PROMPT(courseList, filename, context, content) }],
      }),
      { label: 'inbox.classify', keyHealth: { userId, provider: 'anthropic' } },
    )
    rawResponse = message.content[0].type === 'text' ? message.content[0].text : ''
  }

  const { isContextHint, courseId: rawCourseId, tier, isHomework, dueDate, grade } = parseClassifyResponse(rawResponse)
  // Whitelist the model-returned course_id against THIS user's own courses. The
  // classifier is only shown the user's courses, but a prompt-injected document
  // could steer it to emit an arbitrary id, and the FK does not enforce same-user.
  const courseId = rawCourseId && (courses ?? []).some((c: { course_id: string }) => c.course_id === rawCourseId)
    ? rawCourseId
    : null

  // Auto-dismiss context hints — they're not course materials
  if (isContextHint) {
    await service.from('inbox_items').delete().eq('material_id', materialId).eq('user_id', userId)
    await service.from('materials').delete().eq('material_id', materialId).eq('user_id', userId)
    await service.storage.from('materials').remove([storagePath]).catch(() => {})
    await appendToLog(userId, `Inbox: "${filename}" auto-dismissed as context hint`)
    return { courseId: null, tier: 4, status: 'classified', isHomework: false, dueDate: null, dismissed: true }
  }

  const classificationStatus = courseId ? 'classified' : 'unassigned'

  await service
    .from('materials')
    .update({ processing_status: 'processed', course_id: courseId ?? undefined, tier })
    .eq('material_id', materialId)
    .eq('user_id', userId)

  await service
    .from('inbox_items')
    .update({ classification_status: classificationStatus, course_id: courseId, tier })
    .eq('material_id', materialId)
    .eq('user_id', userId)

  const courseName = (courses ?? []).find((c: { course_id: string; name: string }) => c.course_id === courseId)?.name ?? 'unknown course'
  const tierLabel = ['', 'Syllabus', 'Primary', 'Supplementary', 'Misc'][tier]
  await appendToLog(
    userId,
    `Inbox agent classified "${filename}" → ${classificationStatus === 'classified' ? `${courseName} (Tier ${tier}: ${tierLabel})` : 'unassigned'}`
  )

  // F1: a grade read off returned, graded work becomes a PENDING (confirmed=false)
  // grade_item — a suggestion the student confirms in the Grades panel, never
  // silently counted (vision can misread a handwritten score). Only when the file
  // landed in a real course.
  let gradeSuggested = false
  if (grade && courseId) {
    // Match the model's category guess to one of the course's real scheme
    // categories (case-insensitive); else leave uncategorized.
    let category: string | null = null
    if (grade.categoryGuess) {
      const { data: schemeRows } = await service
        .from('course_grade_schemes').select('category').eq('user_id', userId).eq('course_id', courseId)
      const guess = grade.categoryGuess.toLowerCase()
      category = ((schemeRows ?? []) as { category: string }[]).find(s => s.category.toLowerCase() === guess)?.category ?? null
    }
    const { error: gradeErr } = await service.from('grade_items').insert({
      user_id: userId,
      course_id: courseId,
      category,
      name: grade.name ?? filename.replace(/\.[^.]+$/, '').slice(0, 200),
      points_earned: grade.pointsEarned,
      points_possible: grade.pointsPossible,
      source: 'upload',
      confirmed: false,
    })
    if (gradeErr) console.error('[inbox] pending grade insert failed', gradeErr)
    else {
      gradeSuggested = true
      await appendToLog(userId, `Inbox: found a grade in "${filename}" → ${grade.pointsEarned}/${grade.pointsPossible} (pending confirmation)`)
    }
  }

  // For vision-processed files, extract full text content for RAG
  let ragContent = fullContent
  if (needsVision && visualBlock && classificationStatus === 'classified') {
    const visionText = await extractContentFromVision(client, visualBlock)
    if (visionText.length > 100) ragContent = visionText
  }

  // The heavy tail (embed → profile → flashcards) becomes durable jobs (F1):
  // previously inline awaits / fire-and-forget promises in the upload request —
  // a serverless timeout or a throw after the HTTP 200 silently lost the work
  // with no retry surface. Jobs drain post-response and are swept by cron.
  let enqueuedAny = false

  if (ragContent.length > 100 && classificationStatus === 'classified') {
    await enqueueJob(userId, 'embed', { subjectId: materialId, payload: { text: ragContent.slice(0, EMBED_PAYLOAD_CAP) } })
    enqueuedAny = true
  }

  // Auto-run profiler for syllabuses (tier 1) that were successfully classified.
  // Quota charged at enqueue time to its own 'profiler' bucket so inbox uploads
  // can't bypass the cap onboarding/course-create enforce.
  if (tier === 1 && courseId) {
    const courseName2 = (courses ?? []).find((c: { course_id: string; name: string }) => c.course_id === courseId)?.name ?? 'Course'
    if (await consumeAiQuota(userId, 'profiler')) {
      await enqueueJob(userId, 'profile', { subjectId: materialId, payload: { courseId, courseName: courseName2 } })
      enqueuedAny = true
    } else {
      console.warn(`[inbox] profiler skipped for ${userId} — daily AI cap reached`)
    }
  }

  // Auto-generate flashcards for tier 1 or 2 materials (own 'flashcards' bucket).
  // Delayed slightly so the profiler's topics exist before card generation runs.
  if ((tier === 1 || tier === 2) && courseId && classificationStatus === 'classified') {
    if (await consumeAiQuota(userId, 'flashcards')) {
      await enqueueJob(userId, 'flashcards', {
        payload: { courseId },
        runAfter: tier === 1 ? new Date(Date.now() + 90_000) : undefined,
      })
      enqueuedAny = true
    } else {
      console.warn(`[inbox] flashcard auto-gen skipped for ${userId} — daily AI cap reached`)
    }
  }

  if (enqueuedAny) kickJobs()

  return { courseId, tier, status: classificationStatus, isHomework, dueDate, gradeSuggested }
}

