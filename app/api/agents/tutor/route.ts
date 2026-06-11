import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { dateKeyInTimeZone, startOfLocalDayUtc } from '@/lib/time'
import { DEFAULT_TUTOR_DAILY_LIMIT } from '@/lib/rate-limit'
import { getAppConfig } from '@/lib/app-config'
import {
  buildTutorSystemPrompt,
  getOrCreateSession,
  createSession,
  getOwnedSessionMessages,
  saveMessage,
  deleteMessage,
  autoNameSession,
  type TutorMode,
} from '@/lib/agents/tutor'
import { requireOwnedCourse, requireOwnedSession } from '@/lib/authz'
import { readWikiFile, writeWikiFile } from '@/lib/wiki'
import { newCardDefaults } from '@/lib/fsrs'
import { retrieveChunks } from '@/lib/rag'
import { applyMasteryEvidence, resolveTopicByName, LEARNING_RATES } from '@/lib/mastery'
import { keyFailureKind, markKeyStatus } from '@/lib/ai/call'
import { compactHistory, distillPreviousSessionIfNeeded } from '@/lib/agents/memory'
import { armDistillJob, kickJobs } from '@/lib/jobs'
import { recordUsage } from '@/lib/usage'
import { readJson, badRequest } from '@/lib/api-error'
import { log } from '@/lib/log'
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

type Attachment = {
  name: string
  type: string
  data: string // base64 for images, plain text for text files
}

// Image media types Anthropic's API accepts for base64 image sources.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// Server-side attachment limits (the real trust boundary — client checks are bypassable).
const MAX_ATTACHMENTS = 5
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // ~5MB decoded
const MAX_TEXT_CHARS = 50_000
const MAX_TOTAL_BYTES = 15 * 1024 * 1024

function buildUserContent(message: string, attachments: Attachment[]): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = []

  for (const att of attachments) {
    if (att.type.startsWith('image/')) {
      if (!SUPPORTED_IMAGE_TYPES.has(att.type)) {
        // Unsupported image type: surface to the model as text instead of crashing the call.
        content.push({
          type: 'text',
          text: `[Attached image "${att.name}" (${att.type}) could not be processed — only JPEG, PNG, GIF, and WebP are supported.]`,
        })
        continue
      }
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

  const session = await requireOwnedSession(user.id, sessionId)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await getOwnedSessionMessages(sessionId, user.id)
  return NextResponse.json({ messages })
}

export async function POST(request: Request) {
  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{
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
  }>(request)
  if (!body) return badRequest('invalid_json')

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

  // `mode` feeds the session_log CHECK constraint and the MODE_INSTRUCTIONS
  // prompt lookup — an unlisted value 500s in createSession (unhandled throw)
  // or interpolates 'undefined' into the system prompt. Whitelist before any
  // DB work.
  const VALID_MODES: readonly TutorMode[] = ['answer', 'teach', 'focus', 'homework']
  if (!VALID_MODES.includes(mode)) {
    return badRequest('invalid_mode')
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = await getUserApiKey(user.id)
  if (!apiKey) return NextResponse.json({ error: 'No API key configured' }, { status: 402 })

  // Attachment limits — fail fast before persisting anything or calling Anthropic.
  if (attachments.length > MAX_ATTACHMENTS) {
    return NextResponse.json({ error: 'too_many_attachments' }, { status: 413 })
  }
  let totalAttachmentBytes = 0
  for (const att of attachments) {
    if (att.type.startsWith('image/')) {
      if (!SUPPORTED_IMAGE_TYPES.has(att.type)) {
        return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
      }
      // base64-decoded size is ~3/4 of the encoded string length.
      const decoded = Math.floor((att.data?.length ?? 0) * 0.75)
      if (decoded > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: 'attachment_too_large' }, { status: 413 })
      }
      totalAttachmentBytes += decoded
    } else {
      if ((att.data?.length ?? 0) > MAX_TEXT_CHARS) {
        return NextResponse.json({ error: 'attachment_too_large' }, { status: 413 })
      }
      totalAttachmentBytes += att.data?.length ?? 0
    }
  }
  if (totalAttachmentBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: 'attachment_too_large' }, { status: 413 })
  }

  // Rate limit check
  const service = createServiceClient()
  const ownedCourse = await requireOwnedCourse(user.id, courseId)
  if (!ownedCourse) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  const { data: userRow } = await service
    .from('users')
    .select('daily_message_limit, timezone, suspended')
    .eq('user_id', user.id)
    .single()

  if (userRow?.suspended === true) {
    return NextResponse.json({ error: 'Account suspended.' }, { status: 403 })
  }

  // Global AI kill-switch — the Tutor uses its own message cap (not aiRouteGuard),
  // so the kill-switch must be checked here explicitly (highest-volume AI path).
  // Fresh read so the emergency switch is immediate.
  if ((await getAppConfig({ fresh: true })).aiDisabled) {
    return NextResponse.json({ error: 'AI features are temporarily unavailable. Please try again later.' }, { status: 503 })
  }

  // Per-user daily message cap. A null column means "use the default" — previously
  // null meant unlimited, which left the Tutor (the most-used AI route) uncapped.
  {
    const dailyLimit = userRow?.daily_message_limit ?? DEFAULT_TUTOR_DAILY_LIMIT
    // Reset the counter at the user's local midnight, not the server's (UTC on Vercel).
    const tz = userRow?.timezone ?? 'UTC'
    const todayStart = startOfLocalDayUtc(dateKeyInTimeZone(new Date(), tz), tz)
    const { count } = await service
      .from('session_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('role', 'user')
      .gte('created_at', todayStart.toISOString())
    if ((count ?? 0) >= dailyLimit) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
    }
  }

  if (existingSessionId) {
    const existingSession = await requireOwnedSession(user.id, existingSessionId)
    if (!existingSession || existingSession.course_id !== courseId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
  }

  const sessionId = existingSessionId
    ?? (forceNew
      ? await createSession(user.id, courseId, mode)
      : await getOrCreateSession(user.id, courseId, mode))

  // First message of a UI-new conversation: make sure yesterday's session is
  // distilled into memory BEFORE we build the prompt, so the recap the tutor is
  // about to give includes it (lazy fallback when the 45-min distill job hasn't
  // drained — bounded to ONE inline Haiku call). Time-boxed: it enriches the
  // recap when fast, but a slow distill must not gate the first token — past
  // the deadline we proceed with the existing digest while the distill finishes
  // in the background (its write lands for the next turn).
  const isSessionOpen = !existingSessionId
  if (isSessionOpen) {
    const distillPromise = distillPreviousSessionIfNeeded(user.id, courseId, sessionId)
      .catch(e => console.error('[tutor] lazy distill failed (continuing)', e))
    await Promise.race([
      distillPromise,
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
  }
  const savedUserContent = attachments.length > 0
    ? `[att:${attachments.map(a => a.name).join('|')}]\n${message}`
    : message
  // Keep the id so a failed/empty generation can roll this row back (B7) — it
  // counts against the daily quota and would otherwise replay as an unanswered turn.
  const userMessageId = await saveMessage(sessionId, user.id, 'user', savedUserContent)

  const service2 = createServiceClient()
  const [{ data: courseRow }, { data: courseTopics }] = await Promise.all([
    service2.from('courses').select('course_type, professor_id').eq('course_id', courseId).eq('user_id', user.id).single(),
    service2.from('topics').select('topic_id, name').eq('course_id', courseId).eq('user_id', user.id).order('syllabus_order', { ascending: true }),
  ])

  const topics = (courseTopics ?? []) as { topic_id: string; name: string }[]

  // C5: skip retrieval entirely on trivial conversational turns — "thanks",
  // "go on", "yes" carry no retrieval intent, but each previously cost a
  // billable embedding call + ~4k tokens of injected chunks.
  const TRIVIAL_TURN_RE = /^(yes|yeah|yep|no|nope|nah|ok|okay|sure|thanks|thank you|got it|go on|continue|next|cool|nice|great|hm+|wait)\b[\s!.?]*$/i
  const skipRag = message.trim().length < 4 || TRIVIAL_TURN_RE.test(message.trim())

  // History first: the retrieval query needs conversational context (I10) and
  // compaction needs the transcript. The prompt build and the compaction then
  // run in parallel.
  const history = await getOwnedSessionMessages(sessionId, user.id)
  // In essay mode, historyCutoff is set when the user switches assistance levels —
  // messages before the cutoff are excluded so prior-mode behavior doesn't bleed over.
  const fullPrior = history.slice(historyCutoff, -1)

  // I10: short follow-ups ("why?", "what about x?") embed terribly on their own —
  // retrieval found nothing useful for exactly the turns that need grounding most.
  // Prefix the previous user message so the query carries the subject.
  const lastUserContent = [...fullPrior].reverse()
    .find((m: { role: string }) => m.role === 'user')?.content?.replace(/^\[att:[^\]]+\]\n/, '')
  const retrievalQuery = !skipRag && message.trim().length < 30 && lastUserContent
    ? `${lastUserContent.slice(0, 300)}\n${message}`
    : message

  const [systemPrompt, compacted] = await Promise.all([
    (async () => {
      const ragChunks = skipRag ? [] : await retrieveChunks(retrievalQuery, courseId, user.id, 5).catch(() => [])
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
        // Recap gate: a truly-empty transcript (getOrCreateSession can reuse a
        // same-day session that already has turns — a "Welcome back" mid-
        // conversation reads as a glitch). isSessionOpen still gates the distill.
        isSessionOpen: fullPrior.length === 0,
      })
    })(),
    // M6: long sessions no longer re-send the whole transcript every turn — the
    // older prefix is compacted into a cached brief; the recent window is verbatim.
    compactHistory(user.id, sessionId, fullPrior as { role: string; content: string }[], apiKey),
  ])

  const client = new Anthropic({ apiKey })
  const { summaryBlock: historySummary, messages: priorMessages } = compacted

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
      // Prompt-cache breakpoint: caches ALL tools up to and including this one. The
      // tool schemas are byte-identical every turn (and re-sent on each tool-loop
      // iteration), so this is the highest-ROI, zero-risk cache. Cached reads cost
      // 0.1x; the 5-min TTL easily spans a tutoring turn.
      cache_control: { type: 'ephemeral' as const },
    },
  ]

  const encoder = new TextEncoder()
  const emit = (data: object) => encoder.encode(JSON.stringify(data) + '\n')

  const readable = new ReadableStream({
    async start(controller) {
      let closed = false
      // Set once the assistant turn is durably saved — the outer catch must NOT
      // roll back the user message after a successful exchange (B7).
      let assistantSaved = false
      try {
        const messages: Anthropic.MessageParam[] = [
          ...priorMessages.map((m: { role: string; content: string }) => ({
            role: m.role as 'user' | 'assistant',
            // Strip attachment metadata prefix before sending to model
            content: m.role === 'user' ? m.content.replace(/^\[att:[^\]]+\]\n/, '') : m.content,
          })),
          { role: 'user', content: userContent },
        ]

        // Cache the conversation prefix too: mark the current user message so that
        // tools + system + history up to here are a cache READ on each tool-loop
        // iteration (the loop runs up to 5x) and on the next turn within the TTL.
        // Exactly ONE message breakpoint, set once → total breakpoints stay at 3
        // (tools, static system, this), well under the 4-breakpoint limit.
        {
          const last = messages[messages.length - 1]
          const ephemeral = { type: 'ephemeral' as const }
          if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content, cache_control: ephemeral }]
          } else if (Array.isArray(last.content) && last.content.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(last.content[last.content.length - 1] as any).cache_control = ephemeral
          }
        }

        let fullText = ''
        const serverInlineCards: object[] = []
        let iterations = 0

        while (iterations < 5) {
          iterations++

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamParams: any = {
            model: deepThink ? 'claude-opus-4-8' : 'claude-sonnet-4-6',
            max_tokens: deepThink ? 16000 : 4096,
            // System blocks: cached static prefix (identical for everyone), then —
            // when retrieval ran — the RAG excerpts as their OWN cached block (C1:
            // byte-identical across the up-to-5 tool-loop iterations of a turn and
            // across follow-up turns on the same topic, so the largest repeated
            // payload becomes cache reads), then the uncached dynamic suffix
            // (course, mode, memory, profile + the compacted-history brief).
            // Breakpoints: tools + static + rag + last-user-message = 4 (the max).
            system: [
              { type: 'text', text: systemPrompt.static, cache_control: { type: 'ephemeral' as const } },
              ...(systemPrompt.rag
                ? [{ type: 'text', text: systemPrompt.rag, cache_control: { type: 'ephemeral' as const } }]
                : []),
              {
                type: 'text',
                text: historySummary
                  ? `${systemPrompt.dynamic}\n\n## Conversation so far (compacted)\nEarlier turns of THIS session, compressed — treat as accurate context:\n${historySummary}`
                  : systemPrompt.dynamic,
              },
            ],
            tools,
            messages,
          }

          if (deepThink) {
            // Opus 4.8 rejects thinking.type=enabled; uses adaptive + effort instead.
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

          // Cache observability: turn 1 of a session writes the cache
          // (cache_creation_input_tokens > 0); later turns/iterations should READ it
          // (cache_read_input_tokens > 0). Watch these logs to confirm hits.
          const u = final.usage
          log.debug('[tutor] usage', JSON.stringify({
            model: streamParams.model,
            iter: iterations,
            input: u.input_tokens,
            output: u.output_tokens,
            cache_write: u.cache_creation_input_tokens ?? 0,
            cache_read: u.cache_read_input_tokens ?? 0,
          }))
          // C7: persist for the Settings Usage & Cost panel (was console-only).
          recordUsage(user.id, 'tutor', streamParams.model, u)

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

                // Save cards to flashcards table so they enter spaced repetition, then emit with card_ids.
                // Honest persistence (B7): the supabase client RETURNS errors (it doesn't
                // throw), so the old try/catch never caught a failed insert — the model
                // and UI both claimed "saved" while nothing persisted.
                let savedData: { card_id: string; front: string; back: string }[] = []
                let cardsSaved = false
                try {
                  const saveSvc = createServiceClient()
                  const defaults = newCardDefaults()
                  const { data: inserted, error: insertError } = await saveSvc.from('flashcards').insert(
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
                  if (insertError) throw insertError
                  if (inserted && inserted.length > 0) {
                    savedData = inserted
                    cardsSaved = true
                  }

                  // Update content_coverage for the topic (gates simulated-exam eligibility).
                  if (cardsSaved && resolvedTopicId) {
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
                      .eq('user_id', user.id)
                  }
                } catch (e) {
                  console.error('[tutor] flashcard save failed', e)
                }

                if (cardsSaved) {
                  controller.enqueue(emit({ t: 'card', kind: 'flashcards', topic: input.topic, count: savedData.length, data: savedData }))
                  serverInlineCards.push({ type: 'flashcards', topic: input.topic, count: savedData.length, data: savedData })
                  const cardList = input.cards.map((c, i) => `${i + 1}. Front: ${c.front} | Back: ${c.back}`).join('\n')
                  toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Created ${input.cards.length} flashcards on "${input.topic}" and saved them to the student's deck. Tell the student they're ready and have been added to spaced repetition.\n\nCards you created:\n${cardList}` })
                } else {
                  controller.enqueue(emit({ t: 'error', c: "Flashcards couldn't be saved — please ask the tutor to try again." }))
                  toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'The flashcards could NOT be saved to the student\'s deck (database error). Tell the student saving failed and offer to try again — do NOT claim they were added to spaced repetition.' })
                }
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
                // Clamp once so the value stored and the value shown to the student agree.
                const score = Math.min(1, Math.max(0, Number(input.score)))
                // Unified mastery (F3): one verification answer is EVIDENCE, not an
                // absolute level — EWMA at the tutor_grade learning rate (was an
                // absolute set: one answer nuked/maxed the whole topic, bug B4).
                // Topic resolution: exact case-insensitive match first, then longest
                // containment — shared with the quiz path (the bare ilike could bind
                // to an unrelated topic or silently miss).
                const { data: courseTopics } = await service
                  .from('topics')
                  .select('topic_id, name')
                  .eq('course_id', courseId)
                  .eq('user_id', user.id)
                const topicId = resolveTopicByName(input.topic_name, (courseTopics ?? []) as { topic_id: string; name: string }[])

                let gradeSaved = false
                if (topicId) {
                  try {
                    await applyMasteryEvidence(user.id, [{
                      topicId,
                      observed: score,
                      learningRate: LEARNING_RATES.tutor_grade,
                    }])
                    gradeSaved = true
                  } catch (e) {
                    console.error('[tutor] mastery evidence write failed', e)
                  }
                }

                controller.enqueue(emit({ t: 'grade', score, rationale: input.rationale, topic: input.topic_name }))
                // Honest tool result: don't tell the model "recorded" if it wasn't.
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: gradeSaved
                    ? 'Grade recorded.'
                    : 'Grade shown to the student, but it could not be matched to a tracked topic — no mastery was recorded.',
                })
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
                // The model-supplied `file` is untrusted: course material / attachments
                // can prompt-inject a call to this tool, and the schema enum is only a
                // hint (not runtime-enforced). This tool exists solely to record student
                // learning patterns, so hard-target learning_profile.md and ignore `file`
                // — preventing writes to professor_*.md / index.md / log.md or any path.
                const target = 'learning_profile.md'
                const existing = await readWikiFile(user.id, target) ?? ''
                const timestamp = new Date().toISOString().split('T')[0]
                const updated = existing.trimEnd() + `\n\n- [${timestamp}] ${input.insight}`
                await writeWikiFile(user.id, target, updated, 'tutor')
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
            model: deepThink ? 'claude-opus-4-8' : 'claude-sonnet-4-6',
            deepThink,
            iterations,
          })
          controller.enqueue(emit({ t: 'error', c: `Empty response from model (${deepThink ? 'Opus 4.8' : 'Sonnet 4.6'}). Check server logs.` }))
          // B7: don't persist a blank assistant turn (it replays as an empty bubble),
          // and roll back the user message so the failed turn doesn't burn quota.
          if (userMessageId) {
            await deleteMessage(userMessageId, user.id).catch(e => console.error('[tutor] rollback delete failed', e))
          }
        } else {
          // Persist the assistant turn BEFORE closing the stream, and never let a
          // persistence failure abort the stream — the error event can still reach the
          // client while the controller is open, and the catch below won't double-close.
          try {
            await saveMessage(sessionId, user.id, 'assistant', fullText, serverInlineCards.length > 0 ? serverInlineCards : null)
            assistantSaved = true
          } catch (saveErr) {
            console.error('[tutor] saveMessage failed', saveErr)
            // B7: the assistant turn was lost — roll back the user message too,
            // or it burns quota and replays as a question with no answer. (The
            // streamed text already reached the client live.)
            if (userMessageId) {
              await deleteMessage(userMessageId, user.id).catch(e => console.error('[tutor] rollback delete failed', e))
            }
          }

          // fullPrior (not the compacted window) — compaction never empties a
          // session that has history, but the guard must mean "truly first".
          const isFirstExchange = fullPrior.length === 0
          if (isFirstExchange) {
            autoNameSession(sessionId, user.id, `Student: ${message}\nTutor: ${fullText}`, apiKey)
          }

          // M1: (re-)arm the memory distiller for ~45 min after this (latest)
          // message, then drain any OTHER due jobs post-response.
          await armDistillJob(user.id, sessionId).catch(e => console.error('[tutor] armDistillJob failed', e))
          kickJobs()
        }

        controller.close()
        closed = true
      } catch (err) {
        console.error('[tutor] stream error', err)
        // R5: a rejected/out-of-credit key on the highest-volume AI path marks
        // key health so the dashboard can say "your key is broken".
        const keyFailure = keyFailureKind(err)
        if (keyFailure) markKeyStatus(user.id, 'anthropic', keyFailure)
        // B7: generation died before an assistant turn was saved → roll back the
        // user message (no quota burn, no unanswered turn in history).
        if (!assistantSaved && userMessageId) {
          await deleteMessage(userMessageId, user.id).catch(e => console.error('[tutor] rollback delete failed', e))
        }
        if (!closed) {
          // Never emit the raw exception/DB message to the client — it leaks internals.
          // The real cause is logged server-side above.
          try { controller.enqueue(emit({ t: 'error', c: 'Something went wrong. Please try again.' })) } catch { /* controller may be unwritable */ }
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
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
