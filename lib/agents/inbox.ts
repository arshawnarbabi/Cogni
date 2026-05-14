import Anthropic from '@anthropic-ai/sdk'
import type { DocumentBlockParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { appendToLog } from '@/lib/wiki'
import { runProfiler } from '@/lib/agents/profiler'
import { runFlashcardAgent } from '@/lib/agents/flashcard'
import { processEmbeddings } from '@/lib/rag'
import { requireOwnedCourse } from '@/lib/authz'

type ClassifyResult = {
  courseId: string | null
  tier: number
  status: 'classified' | 'unassigned' | 'failed' | 'unreadable'
  isHomework: boolean
  dueDate: string | null
  dismissed?: boolean
}

type ExtractResult = {
  text: string
  isImagePdf: boolean
  isImageFile: boolean
  imageMimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4MB — Anthropic limit is ~5MB

async function compressImageIfNeeded(
  buffer: Buffer,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<{ buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  if (buffer.length <= MAX_IMAGE_BYTES) return { buffer, mimeType }
  try {
    // sharp is native and optional at runtime — lazy-load so a missing binary can't crash the route on import
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp')
    const compressed: Buffer = await sharp(buffer)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
    return { buffer: compressed, mimeType: 'image/jpeg' }
  } catch {
    return { buffer, mimeType }
  }
}

async function extractText(buffer: Buffer, fileType: string, filename: string): Promise<ExtractResult> {
  const ext = fileType.toLowerCase().replace('.', '')

  if (ext === 'txt' || ext === 'md' || filename.endsWith('.txt') || filename.endsWith('.md')) {
    return { text: buffer.toString('utf-8'), isImagePdf: false, isImageFile: false }
  }

  if (ext === 'pdf' || filename.endsWith('.pdf')) {
    try {
      // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(buffer)
      const meaningful = (data.text ?? '').replace(/\s+/g, '').length
      const isImagePdf = meaningful < 50
      return { text: data.text ?? '', isImagePdf, isImageFile: false }
    } catch {
      return { text: '', isImagePdf: true, isImageFile: false }
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    const mimeMap: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    }
    return { text: '', isImagePdf: false, isImageFile: true, imageMimeType: mimeMap[ext] ?? 'image/jpeg' }
  }

  return { text: `[File: ${filename}]`, isImagePdf: false, isImageFile: false }
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

const EXTRACT_PROMPT = `Transcribe all readable content from this document or image.
Include all text, equations, labels, headings, and problem statements exactly as they appear.
Format as plain text. Return ONLY the transcribed content, nothing else.`

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

async function extractContentFromVision(
  client: Anthropic,
  visualBlock: DocumentBlockParam | ImageBlockParam,
): Promise<string> {
  try {
    const textBlock: TextBlockParam = { type: 'text', text: EXTRACT_PROMPT }
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [visualBlock, textBlock] }],
    })
    return msg.content[0].type === 'text' ? msg.content[0].text : ''
  } catch {
    return ''
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
  let visualBlock: DocumentBlockParam | ImageBlockParam | null = null

  if (isImagePdf) {
    const base64Pdf = buffer.toString('base64')
    visualBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf },
    } satisfies DocumentBlockParam
  } else if (isImageFile && imageMimeType) {
    const { buffer: compressed, mimeType: finalMime } = await compressImageIfNeeded(buffer, imageMimeType)
    const base64Img = compressed.toString('base64')
    visualBlock = {
      type: 'image',
      source: { type: 'base64', media_type: finalMime, data: base64Img },
    } satisfies ImageBlockParam
  }

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

  const { isContextHint, courseId, tier, isHomework, dueDate } = parseClassifyResponse(rawResponse)

  // Auto-dismiss context hints — they're not course materials
  if (isContextHint) {
    await service.from('inbox_items').delete().eq('material_id', materialId).eq('user_id', userId)
    await service.from('materials').delete().eq('material_id', materialId).eq('user_id', userId)
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

  // Auto-run profiler for syllabuses (tier 1) that were successfully classified
  if (tier === 1 && courseId) {
    const courseName2 = (courses ?? []).find((c: { course_id: string; name: string }) => c.course_id === courseId)?.name ?? 'Course'
    await runProfiler(userId, materialId, courseId, courseName2)
  }

  // Auto-generate flashcards for tier 1 or 2 materials
  if ((tier === 1 || tier === 2) && courseId && classificationStatus === 'classified') {
    autoGenerateFlashcards(userId, courseId).catch(() => {})
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
