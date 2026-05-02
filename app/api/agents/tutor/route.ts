import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import {
  buildTutorSystemPrompt,
  getOrCreateSession,
  createSession,
  getSessionMessages,
  saveMessage,
  autoNameSession,
  type TutorMode,
} from '@/lib/agents/tutor'
import { readWikiFile, writeWikiFile } from '@/lib/wiki'
import { newCardDefaults } from '@/lib/fsrs'
import { retrieveChunks } from '@/lib/rag'
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

type Attachment = {
  name: string
  type: string
  data: string // base64 for images, plain text for text files
}

function buildUserContent(message: string, attachments: Attachment[]): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = []

  for (const att of attachments) {
    if (att.type.startsWith('image/')) {
      const mediaType = att.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: att.data },
      })
    } else {
      content.push({
        type: 'text',
        text: `[Attached file: ${att.name}]\n${att.data}`,
      })
    }
  }

  content.push({ type: 'text', text: message })
  return content
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const messages = await getSessionMessages(sessionId)
  return NextResponse.json({ messages })
}

export async function POST(request: Request) {
  const body = await request.json() as {
    courseId: string
    courseName: string
    message: string
    mode?: TutorMode
    deepThink?: boolean
    sessionId?: string
    forceNew?: boolean
    attachments?: Attachment[]
    essayContent?: string
    assistanceLevel?: 'feedback' | 'suggest' | 'assist'
    historyCutoff?: number
  }

  const {
    courseId,
    courseName,
    message,
    mode = 'answer',
    deepThink = false,
    sessionId: existingSessionId,
    forceNew = false,
    attachments = [],
    essayContent,
    assistanceLevel = 'suggest',
    historyCutoff = 0,
  } = body

  if (!courseId || !message?.trim()) {
    return NextResponse.json({ error: 'Missing courseId or message' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = await getUserApiKey(user.id)
  if (!apiKey) return NextResponse.json({ error: 'No API key configured' }, { status: 402 })

  // Rate limit check
  const service = createServiceClient()
  const { data: userRow } = await service
    .from('users')
    .select('daily_message_limit')
    .eq('user_id', user.id)
    .single()

  if (userRow?.daily_message_limit != null) {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const { count } = await service
      .from('session_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('role', 'user')
      .gte('created_at', todayStart.toISOString())
    if ((count ?? 0) >= userRow.daily_message_limit) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
    }
  }

  const sessionId = existingSessionId
    ?? (forceNew
      ? await createSession(user.id, courseId, mode)
      : await getOrCreateSession(user.id, courseId, mode))
  const savedUserContent = attachments.length > 0
    ? `[att:${attachments.map(a => a.name).join('|')}]\n${message}`
    : message
  await saveMessage(sessionId, user.id, 'user', savedUserContent)

  const service2 = createServiceClient()
  const [{ data: courseRow }, { data: courseTopics }] = await Promise.all([
    service2.from('courses').select('course_type, professor_id').eq('course_id', courseId).single(),
    service2.from('topics').select('topic_id, name').eq('course_id', courseId).eq('user_id', user.id).order('syllabus_order', { ascending: true }),
  ])

  const topics = (courseTopics ?? []) as { topic_id: string; name: string }[]

  const [systemPrompt, history] = await Promise.all([
    (async () => {
      const ragChunks = await retrieveChunks(message, courseId, user.id, 5).catch(() => [])
      const ragContext = ragChunks.length > 0
        ? ragChunks.map(c => c.content).join('\n\n---\n\n')
        : undefined
      return buildTutorSystemPrompt(user.id, courseId, courseName, mode, {
        essayMode: !!essayContent,
        assistanceLevel,
        courseType: courseRow?.course_type ?? undefined,
        professorId: courseRow?.professor_id ?? undefined,
        ragContext,
        topics,
      })
    })(),
    getSessionMessages(sessionId),
  ])

  const client = new Anthropic({ apiKey })
  // In essay mode, historyCutoff is set when the user switches assistance levels —
  // messages before the cutoff are excluded so prior-mode behavior doesn't bleed over.
  const priorMessages = history.slice(historyCutoff, -1)

  // Inject essay content as context prefix when in essay mode
  const effectiveMessage = essayContent
    ? `[Current essay content]\n${essayContent}\n\n[Student message]\n${message}`
    : message

  const userContent = buildUserContent(effectiveMessage, attachments)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
      name: 'create_flashcards',
      description: 'Create and save a set of flashcards for the student. Before calling, ask ONE brief question about which specific subtopic or aspect to focus on, unless the student already specified — e.g. "Any particular aspect — power rule, chain rule, trig? Or all derivatives?" Then generate based on their answer. Wrap every math expression in LaTeX delimiters so it renders correctly: inline math uses single dollar signs like $f(x) = x^2$, block/display math uses double dollar signs like $$\\int_0^1 x\\,dx$$. Never write raw math like "x^2" or "integral from 0 to 1" — always LaTeX-delimit it. This applies to both front and back of every card.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'The topic of the flashcards (human-readable label shown to the student)' },
          topic_id: { type: 'string', description: 'The topic_id from the course topics list in your instructions. Pick the best-matching topic. Leave empty string if no topics are loaded.' },
          cards: {
            type: 'array',
            description: 'The flashcard pairs',
            items: {
              type: 'object',
              properties: {
                front: { type: 'string', description: 'Question or term' },
                back: { type: 'string', description: 'Answer or definition' },
              },
              required: ['front', 'back'],
            },
          },
        },
        required: ['topic', 'topic_id', 'cards'],
      },
    },
    {
      name: 'create_quiz',
      description: 'Create a practice quiz for the student. Before calling, ask ONE brief question: what format (MC / short answer / mix) and how many questions? Give a recommendation based on what the student was just working on — e.g. "I\'d suggest 10 mixed questions on derivatives. MC, short answer, or mixed? And how many?" Then generate immediately once they answer. Wrap every math expression in LaTeX delimiters so it renders correctly: inline math uses single dollar signs like $f(x) = x^2$, block/display math uses double dollar signs like $$\\int_0^1 x\\,dx$$. Never write raw math like "x^2" or "f\'(x)" — always LaTeX-delimit it. This applies to every field: question, options, answer, and explanation.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'The topic of the quiz (human-readable label shown to the student)' },
          topic_id: { type: 'string', description: 'The topic_id from the course topics list in your instructions. Pick the best-matching topic. Leave empty string if no topics are loaded.' },
          questions: {
            type: 'array',
            description: 'Quiz questions with multiple-choice options',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: '4 answer choices' },
                answer: { type: 'string', description: 'The correct option text' },
                explanation: { type: 'string', description: 'Brief explanation of the answer' },
              },
              required: ['question', 'options', 'answer', 'explanation'],
            },
          },
        },
        required: ['topic', 'topic_id', 'questions'],
      },
    },
    {
      name: 'grade_answer',
      description: 'Grade a student\'s answer to a verification question you explicitly posed. Call this only after the student has answered a question you asked to check their understanding.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic_name: { type: 'string', description: 'The topic being tested' },
          score: { type: 'number', description: 'Score from 0.0 to 1.0' },
          rationale: { type: 'string', description: 'Brief explanation of the score' },
        },
        required: ['topic_name', 'score', 'rationale'],
      },
    },
    {
      name: 'open_essay_mode',
      description: 'Open the essay writing split-screen. Call this IMMEDIATELY whenever the student mentions writing a paper, essay, report, or written assignment — even if the request sounds like ghostwriting. Do NOT refuse; open essay mode and explain you will help them develop it together. Never call create_flashcards in the same response as open_essay_mode.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Brief description of the essay topic' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'suggest_edit',
      description: 'Propose a tracked edit to the student\'s essay. Only call when assistance is "suggest" or "assist" and the student has written at least one paragraph. Return the exact target text to replace and the replacement.',
      input_schema: {
        type: 'object' as const,
        properties: {
          target: { type: 'string', description: 'Exact substring of the essay to replace. Empty string to append at end.' },
          replacement: { type: 'string', description: 'The proposed replacement text' },
          instruction: { type: 'string', description: 'One sentence explaining what this edit does and why' },
        },
        required: ['target', 'replacement', 'instruction'],
      },
    },
    {
      name: 'create_chart',
      description: 'Render a visual chart directly in the chat. Use for quantitative data — comparisons between discrete values, trends over a range, proportions of a whole. Examples: topic frequency by professor weight, sin(x) plotted over 0–2π, exam score distributions, grade breakdowns. Do NOT use for processes, flows, or relationships between concepts — use a ```mermaid code block for those instead.',
      input_schema: {
        type: 'object' as const,
        properties: {
          chart_type: {
            type: 'string',
            enum: ['line', 'bar', 'pie'],
            description: 'line: continuous trends or function plots. bar: comparisons between discrete categories. pie: proportions of a whole (use sparingly, only when parts-of-whole is the point).',
          },
          title: { type: 'string', description: 'Chart title shown above the chart' },
          data: {
            type: 'array',
            description: 'Data points. label is the x-axis category or tick. value is the primary y-axis quantity. value2 is an optional second series.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Category name or x-axis label' },
                value: { type: 'number', description: 'Primary value' },
                value2: { type: 'number', description: 'Optional second series — omit unless comparing two datasets' },
              },
              required: ['label', 'value'],
            },
          },
          x_label: { type: 'string', description: 'Optional x-axis label' },
          y_label: { type: 'string', description: 'Optional y-axis label' },
          value_label: { type: 'string', description: 'Legend label for the primary series (e.g. "sin(x)")' },
          value2_label: { type: 'string', description: 'Legend label for the second series (e.g. "cos(x)")' },
        },
        required: ['chart_type', 'title', 'data'],
      },
    },
    {
      name: 'write_wiki_pattern',
      description: 'Write a durable, non-obvious learning pattern about this student to their wiki. Only call for genuinely persistent patterns — not routine interactions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file: { type: 'string', enum: ['learning_profile.md'], description: 'Which wiki file to update' },
          insight: { type: 'string', description: 'The specific insight to append (1-2 sentences)' },
        },
        required: ['file', 'insight'],
      },
    },
  ]

  const encoder = new TextEncoder()
  const emit = (data: object) => encoder.encode(JSON.stringify(data) + '\n')

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const messages: Anthropic.MessageParam[] = [
          ...priorMessages.map((m: { role: string; content: string }) => ({
            role: m.role as 'user' | 'assistant',
            // Strip attachment metadata prefix before sending to model
            content: m.role === 'user' ? m.content.replace(/^\[att:[^\]]+\]\n/, '') : m.content,
          })),
          { role: 'user', content: userContent },
        ]

        let fullText = ''
        const serverInlineCards: object[] = []
        let iterations = 0

        while (iterations < 5) {
          iterations++

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamParams: any = {
            model: deepThink ? 'claude-opus-4-7' : 'claude-sonnet-4-6',
            max_tokens: deepThink ? 16000 : 4096,
            system: systemPrompt,
            tools,
            messages,
          }

          if (deepThink) {
            // Opus 4.7 rejects thinking.type=enabled; uses adaptive + effort instead.
            streamParams.thinking = { type: 'adaptive' }
            streamParams.output_config = { effort: 'high' }
          }

          const stream = client.messages.stream(streamParams)
          const toolInputs = new Map<number, { id: string; name: string; inputJson: string }>()
          const thinkingIndices = new Set<number>()

          for await (const event of stream) {
            if (event.type === 'content_block_start') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cb = event.content_block as any
              if (cb.type === 'thinking') {
                thinkingIndices.add(event.index)
                controller.enqueue(emit({ t: 'think_start' }))
              } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
                toolInputs.set(event.index, {
                  id: cb.id,
                  name: cb.name,
                  inputJson: '',
                })
                if (cb.name === 'web_search') {
                  controller.enqueue(emit({ t: 'search_start' }))
                }
              }
            } else if (event.type === 'content_block_delta') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const delta = event.delta as any
              if (delta.type === 'text_delta') {
                fullText += delta.text
                controller.enqueue(emit({ t: 'text', c: delta.text }))
              } else if (delta.type === 'thinking_delta') {
                controller.enqueue(emit({ t: 'think_delta', c: delta.thinking }))
              } else if (delta.type === 'input_json_delta') {
                const blk = toolInputs.get(event.index)
                if (blk) blk.inputJson += delta.partial_json
              }
            } else if (event.type === 'content_block_stop') {
              if (thinkingIndices.has(event.index)) {
                controller.enqueue(emit({ t: 'think_stop' }))
              }
              const blk = toolInputs.get(event.index)
              if (blk?.name === 'web_search') {
                let query = ''
                try {
                  const input = JSON.parse(blk.inputJson) as { query: string }
                  query = input.query ?? ''
                } catch { /* no query available */ }
                controller.enqueue(emit({ t: 'search_done', q: query }))
              }
            }
          }

          const final = await stream.finalMessage()

          if (final.stop_reason === 'tool_use') {
            const toolResults: Anthropic.ToolResultBlockParam[] = []

            for (const block of final.content) {
              if (block.type !== 'tool_use') continue
              // web_search is handled server-side by Anthropic — skip
              if (block.name === 'web_search') continue

              if (block.name === 'open_essay_mode') {
                const input = block.input as { topic: string }
                controller.enqueue(emit({ t: 'essay_open', topic: input.topic }))
                serverInlineCards.push({ type: 'essay', topic: input.topic, count: 0 })
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Essay mode opened. Tell the student the writing space is ready.' })
              } else if (block.name === 'suggest_edit') {
                const input = block.input as { target: string; replacement: string; instruction: string }
                controller.enqueue(emit({ t: 'essay_edit', target: input.target, replacement: input.replacement, instruction: input.instruction }))
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Edit suggested and shown to student as a tracked change.' })
              } else if (block.name === 'create_flashcards') {
                const input = block.input as { topic: string; topic_id: string; cards: { front: string; back: string }[] }

                // Use topic_id provided by AI (chosen from system prompt topic list)
                const resolvedTopicId = input.topic_id && topics.some(t => t.topic_id === input.topic_id)
                  ? input.topic_id
                  : null

                // Save cards to flashcards table so they enter spaced repetition, then emit with card_ids
                let savedData: { card_id: string; front: string; back: string }[] = input.cards.map(c => ({ card_id: '', front: c.front, back: c.back }))
                try {
                  const saveSvc = createServiceClient()
                  const defaults = newCardDefaults()
                  const { data: inserted } = await saveSvc.from('flashcards').insert(
                    input.cards.map(card => ({
                      user_id: user.id,
                      course_id: courseId,
                      topic_id: resolvedTopicId,
                      front: card.front,
                      back: card.back,
                      hint: null,
                      ...defaults,
                    }))
                  ).select('card_id, front, back')
                  if (inserted) savedData = inserted

                  // Update content_coverage for the topic (gates simulated-exam eligibility).
                  if (resolvedTopicId) {
                    const { count: cardCount } = await saveSvc
                      .from('flashcards')
                      .select('card_id', { count: 'exact', head: true })
                      .eq('user_id', user.id)
                      .eq('topic_id', resolvedTopicId)
                    const coverage = Math.min(1.0, (cardCount ?? input.cards.length) / 10)
                    await saveSvc
                      .from('topics')
                      .update({ content_coverage: coverage })
                      .eq('topic_id', resolvedTopicId)
                  }
                } catch { /* non-critical */ }

                controller.enqueue(emit({ t: 'card', kind: 'flashcards', topic: input.topic, count: savedData.length, data: savedData }))
                serverInlineCards.push({ type: 'flashcards', topic: input.topic, count: savedData.length, data: savedData })

                const cardList = input.cards.map((c, i) => `${i + 1}. Front: ${c.front} | Back: ${c.back}`).join('\n')
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Created ${input.cards.length} flashcards on "${input.topic}" and saved them to the student's deck. Tell the student they're ready and have been added to spaced repetition.\n\nCards you created:\n${cardList}` })
              } else if (block.name === 'create_quiz') {
                const input = block.input as { topic: string; topic_id: string; questions: object[] }
                controller.enqueue(emit({ t: 'card', kind: 'quiz', topic: input.topic, count: input.questions.length, data: input.questions }))
                serverInlineCards.push({ type: 'quiz', topic: input.topic, count: input.questions.length, data: input.questions })
                const questionList = (input.questions as Array<{ question: string; answer: string; explanation: string }>)
                  .map((q, i) => `${i + 1}. ${q.question}\n   Answer: ${q.answer}\n   Explanation: ${q.explanation}`)
                  .join('\n\n')
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Created ${input.questions.length} quiz questions on "${input.topic}". Tell the student the quiz is ready.\n\nQuestions you created:\n${questionList}` })
              } else if (block.name === 'grade_answer') {
                const input = block.input as { topic_name: string; score: number; rationale: string }
                const service = createServiceClient()
                // Look up topic for this course, update mastery
                const { data: topic } = await service
                  .from('topics')
                  .select('topic_id')
                  .eq('course_id', courseId)
                  .ilike('name', input.topic_name)
                  .limit(1)
                  .single()

                if (topic) {
                  await service.from('topic_mastery').upsert({
                    user_id: user.id,
                    topic_id: topic.topic_id,
                    mastery_score: input.score,
                  }, { onConflict: 'user_id,topic_id' })
                }

                controller.enqueue(emit({ t: 'grade', score: input.score, rationale: input.rationale, topic: input.topic_name }))
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Grade recorded.' })
              } else if (block.name === 'create_chart') {
                const input = block.input as {
                  chart_type: string
                  title: string
                  data: { label: string; value: number; value2?: number }[]
                  x_label?: string
                  y_label?: string
                  value_label?: string
                  value2_label?: string
                }
                controller.enqueue(emit({
                  t: 'chart',
                  chart_type: input.chart_type,
                  title: input.title,
                  data: input.data,
                  x_label: input.x_label,
                  y_label: input.y_label,
                  value_label: input.value_label,
                  value2_label: input.value2_label,
                }))
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Chart rendered inline in the chat.' })
              } else if (block.name === 'write_wiki_pattern') {
                const input = block.input as { file: string; insight: string }
                const existing = await readWikiFile(user.id, input.file) ?? ''
                const timestamp = new Date().toISOString().split('T')[0]
                const updated = existing.trimEnd() + `\n\n- [${timestamp}] ${input.insight}`
                await writeWikiFile(user.id, input.file, updated, 'tutor')
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Pattern recorded.' })
              }
            }

            if (toolResults.length > 0) {
              messages.push(
                { role: 'assistant', content: final.content },
                { role: 'user', content: toolResults },
              )
            } else {
              break // only server-side tools (web_search), no custom tool results needed
            }
          } else {
            break
          }
        }

        if (!fullText.trim()) {
          console.error('[tutor] empty response', {
            model: deepThink ? 'claude-opus-4-7' : 'claude-sonnet-4-6',
            deepThink,
            iterations,
          })
          controller.enqueue(emit({ t: 'error', c: `Empty response from model (${deepThink ? 'Opus 4.7' : 'Sonnet 4.6'}). Check server logs.` }))
        }

        controller.close()
        await saveMessage(sessionId, user.id, 'assistant', fullText, serverInlineCards.length > 0 ? serverInlineCards : null)

        const isFirstExchange = priorMessages.length === 0
        if (isFirstExchange) {
          autoNameSession(sessionId, user.id, `Student: ${message}\nTutor: ${fullText}`, apiKey)
        }
      } catch (err) {
        console.error('[tutor] stream error', err)
        controller.enqueue(emit({ t: 'error', c: err instanceof Error ? err.message : String(err) }))
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Session-Id': sessionId,
      'Transfer-Encoding': 'chunked',
    },
  })
}
