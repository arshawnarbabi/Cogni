import Anthropic from '@anthropic-ai/sdk'
import type { DocumentBlockParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { appendToLog } from '@/lib/wiki'
import { runProfiler } from '@/lib/agents/profiler'
import { runFlashcardAgent } from '@/lib/agents/flashcard'
import { processEmbeddings } from '@/lib/rag'
import { requireOwnedCourse } from '@/lib/authz'
import { consumeAiQuota } from '@/lib/rate-limit'
import { extractText, buildVisualBlock, extractContentFromVision } from '@/lib/extract-text'

type ClassifyResult = {
  courseId: string | null
  tier: number
  status: 'classified' | 'unassigned' | 'failed' | 'unreadable'
  isHomework: boolean
  dueDate: string | null
  dismissed?: boolean
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

Respond with exactly: {"is_context_hint":<true|false>,"course_id":"<uuid or null>","tier":<1-4>,"is_homework":<true|false>,"due_date":"<YYYY-MM-DD or null>"}`

function parseClassifyResponse(raw: string): { isContextHint: boolean; courseId: string | null; tier: number; isHomework: boolean; dueDate: string | null } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  const candidate = match ? match[0] : cleaned
  try {
    const parsed = JSON.parse(candidate)
    return {
      isContextHint: parsed.is_context_hint === true,
      courseId: parsed.course_id ?? null,
      tier: typeof parsed.tier === 'number' ? Math.max(1, Math.min(4, parsed.tier)) : 4,
      isHomework: parsed.is_homework === true,
      dueDate: typeof parsed.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date) ? parsed.due_date : null,
    }
  } catch {
    return { isContextHint: false, courseId: null, tier: 4, isHomework: false, dueDate: null }
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
      await processEmbeddings(userId, materialId, fullContent).catch(e => console.error('[rag] processEmbeddings failed', e))
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
      const visionMessage = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: [visualBlock, textBlock] }],
      })
      rawResponse = visionMessage.content[0].type === 'text' ? visionMessage.content[0].text : ''
    } catch (e) {
      console.error('[inbox] vision classification failed', e)
      await service.from('materials').update({ processing_status: 'failed' }).eq('material_id', materialId).eq('user_id', userId)
      await service.from('inbox_items').update({ classification_status: 'unreadable' }).eq('material_id', materialId).eq('user_id', userId)
      await appendToLog(userId, `Inbox: "${filename}" marked unreadable — vision failed`)
      return { courseId: null, tier: 4, status: 'unreadable', isHomework: false, dueDate: null }
    }
  } else {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: CLASSIFY_PROMPT(courseList, filename, context, content) }],
    })
    rawResponse = message.content[0].type === 'text' ? message.content[0].text : ''
  }

  const { isContextHint, courseId: rawCourseId, tier, isHomework, dueDate } = parseClassifyResponse(rawResponse)
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

  // For vision-processed files, extract full text content for RAG
  let ragContent = fullContent
  if (needsVision && visualBlock && classificationStatus === 'classified') {
    const visionText = await extractContentFromVision(client, visualBlock)
    if (visionText.length > 100) ragContent = visionText
  }

  // Process embeddings for RAG
  if (ragContent.length > 100 && classificationStatus === 'classified') {
    await processEmbeddings(userId, materialId, ragContent).catch(e => console.error('[rag] processEmbeddings failed', e))
  }

  // Auto-run profiler for syllabuses (tier 1) that were successfully classified.
  // Charge it to its own 'profiler' bucket so inbox uploads can't bypass the
  // profiler cap that onboarding/course-create enforce (inbox already consumed
  // one 'inbox_classify' unit upstream).
  if (tier === 1 && courseId) {
    const courseName2 = (courses ?? []).find((c: { course_id: string; name: string }) => c.course_id === courseId)?.name ?? 'Course'
    if (await consumeAiQuota(userId, 'profiler')) {
      await runProfiler(userId, materialId, courseId, courseName2)
    } else {
      console.warn(`[inbox] profiler skipped for ${userId} — daily AI cap reached`)
    }
  }

  // Auto-generate flashcards for tier 1 or 2 materials (own 'flashcards' bucket).
  if ((tier === 1 || tier === 2) && courseId && classificationStatus === 'classified') {
    if (await consumeAiQuota(userId, 'flashcards')) {
      autoGenerateFlashcards(userId, courseId).catch(() => {})
    } else {
      console.warn(`[inbox] flashcard auto-gen skipped for ${userId} — daily AI cap reached`)
    }
  }

  return { courseId, tier, status: classificationStatus, isHomework, dueDate }
}

async function autoGenerateFlashcards(userId: string, courseId: string) {
  const service = createServiceClient()

  const { data: topics } = await service
    .from('topics')
    .select('topic_id, name')
    .eq('course_id', courseId)
    .eq('user_id', userId)

  if (!topics || topics.length === 0) return

  const topicIds = topics.map((t: { topic_id: string }) => t.topic_id)

  const { data: existingCards } = await service
    .from('flashcards')
    .select('topic_id')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .in('topic_id', topicIds)

  const topicsWithCards = new Set((existingCards ?? []).map((c: { topic_id: string | null }) => c.topic_id).filter(Boolean))
  const topicsNeedingCards = topics.filter((t: { topic_id: string }) => !topicsWithCards.has(t.topic_id)).slice(0, 5)

  for (const topic of topicsNeedingCards) {
    await runFlashcardAgent(userId, courseId, topic.topic_id).catch(() => {})
  }
}
