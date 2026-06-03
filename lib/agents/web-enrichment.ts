import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'

export async function runWebEnrichment(
  userId: string,
  courseId: string,
  courseName: string,
  professorName: string,
  apiKey: string,
): Promise<void> {
  const tag = `[web-enrichment ${courseName}]`
  const client = new Anthropic({ apiKey })

  // Only create one suggestion per course — skip if one already exists (any status)
  const service = createServiceClient()
  const { data: existing } = await service
    .from('course_web_suggestions')
    .select('id')
    .eq('course_id', courseId)
    .limit(1)
    .maybeSingle()

  if (existing) {
    console.log(`${tag} suggestion already exists, skipping`)
    return
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Search the web for the public syllabus or course outline for "${courseName}" taught by professor "${professorName}". Look for a real course document containing the list of topics covered, exam dates, and grading breakdown. Return the full raw text of whatever you find — do not summarize or paraphrase, return it verbatim. If you cannot find a clear match for this specific course and professor, reply with exactly: NOT_FOUND`,
    },
  ]

  let finalMsg: Anthropic.Message | null = null
  let iterations = 0

  try {
    while (iterations < 4) {
      iterations++

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamParams: any = {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }

      const stream = client.messages.stream(streamParams)

      // Drain the stream so finalMessage() resolves; the answer is derived
      // from the final message's text blocks, not a cross-turn accumulator.
      for await (const _event of stream) {
        void _event
      }

      const final = await stream.finalMessage()
      finalMsg = final

      if (final.stop_reason === 'tool_use') {
        const hasCustomTools = final.content.some(
          b => b.type === 'tool_use' && (b as Anthropic.ToolUseBlock).name !== 'web_search'
        )
        if (!hasCustomTools) {
          messages.push({ role: 'assistant', content: final.content })
          continue
        }
      }

      if (final.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: final.content })
        continue
      }

      break
    }
  } catch (e) {
    console.error(`${tag} Anthropic call failed`, e)
    return
  }

  const finalText = (finalMsg?.content ?? [])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()

  if (!finalText || /\bNOT_FOUND\b/.test(finalText) || finalText.length < 100) {
    console.log(`${tag} no useful content found`)
    return
  }

  await service.from('course_web_suggestions').insert({
    course_id: courseId,
    user_id: userId,
    content: finalText,
  })

  console.log(`${tag} stored web suggestion (${finalText.length} chars)`)
}
