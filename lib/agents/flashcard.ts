import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { newCardDefaults } from '@/lib/fsrs'
import { appendToLog } from '@/lib/wiki'

type GeneratedCard = { front: string; back: string; hint?: string }

async function generateCards(
  client: Anthropic,
  topicName: string,
  courseName: string,
  context: string
): Promise<GeneratedCard[]> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Create 6–10 flashcards for the topic "${topicName}" in the course "${courseName}".
${context ? `\nContext from course materials:\n${context.slice(0, 4000)}\n` : ''}
Rules:
- Front: a concise question or prompt that tests active recall
- Back: a clear, complete answer (1–3 sentences max)
- Hint (optional): a one-word or short phrase hint
- Cover the most important concepts, definitions, and applications
- Return ONLY valid JSON, no other text

Respond with exactly: {"cards":[{"front":"...","back":"...","hint":"..."},...]}`
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
    if (Array.isArray(parsed.cards)) return parsed.cards.slice(0, 15)
    console.error('[flashcard] parsed JSON but cards is not an array', parsed)
    return []
  } catch (e) {
    console.error('[flashcard] JSON parse failed. Raw response was:\n---\n' + raw.slice(0, 500) + '\n---', e)
    return []
  }
}

export async function runFlashcardAgent(
  userId: string,
  courseId: string,
  topicId: string
): Promise<{ generated: number; error?: string }> {
  const service = createServiceClient()

  const apiKey = await getUserApiKey(userId)
  if (!apiKey) return { generated: 0, error: 'No API key configured' }

  const { data: topic } = await service
    .from('topics')
    .select('name, courses ( name )')
    .eq('topic_id', topicId)
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .single()

  if (!topic) return { generated: 0, error: 'Topic not found' }

  const topicName = topic.name
  const courseName = (topic.courses as { name: string } | null)?.name ?? 'Course'

  // Gather context from processed materials for this course
  const { data: materials } = await service
    .from('materials')
    .select('storage_path, file_type, filename')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .eq('processing_status', 'processed')
    .limit(3)

  let context = ''
  for (const mat of materials ?? []) {
    if (!mat.storage_path) continue
    const { data: fileData } = await service.storage.from('materials').download(mat.storage_path)
    if (!fileData) continue
    const buf = Buffer.from(await fileData.arrayBuffer())
    let text = ''
    if (mat.file_type === 'pdf') {
      try {
        // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse')
        text = (await pdfParse(buf)).text
      } catch { text = buf.toString('utf-8') }
    } else {
      text = buf.toString('utf-8')
    }
    context += `\n--- ${mat.filename} ---\n${text.slice(0, 2000)}`
    if (context.length > 5000) break
  }

  const client = new Anthropic({ apiKey })
  const cards = await generateCards(client, topicName, courseName, context)

  if (cards.length === 0) return { generated: 0, error: 'No cards generated' }

  const defaults = newCardDefaults()

  const { error } = await service.from('flashcards').insert(
    cards.map(card => ({
      user_id: userId,
      course_id: courseId,
      topic_id: topicId,
      front: card.front,
      back: card.back,
      hint: card.hint ?? null,
      ...defaults,
    }))
  )

  if (error) return { generated: 0, error: error.message }

  // Update content_coverage: ratio of cards to target (10 cards == full coverage).
  // Simulated-exam filter gates topics by coverage > 0.05, so this must be written or that feature breaks.
  const { count: cardCount } = await service
    .from('flashcards')
    .select('card_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('topic_id', topicId)

  const coverage = Math.min(1.0, (cardCount ?? cards.length) / 10)
  await service
    .from('topics')
    .update({ content_coverage: coverage })
    .eq('topic_id', topicId)
    .eq('user_id', userId)

  await appendToLog(userId, `Flashcard agent generated ${cards.length} cards for topic "${topicName}"`)

  return { generated: cards.length }
}
