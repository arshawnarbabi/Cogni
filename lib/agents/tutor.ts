import { createServiceClient } from '@/lib/supabase/server'
import { readWikiFile } from '@/lib/wiki'
import { dateKeyInTimeZone, startOfLocalDayUtc } from '@/lib/time'
import { getCourseMemory } from '@/lib/agents/memory'
import { clampBlock } from '@/lib/agents/context-budget'

export type TutorMode = 'answer' | 'teach' | 'focus'

const MODE_INSTRUCTIONS: Record<TutorMode, string> = {
  answer: 'Answer questions directly and concisely. Explain clearly but don\'t over-elaborate unless the student asks.',
  teach: `Use the Socratic method. Guide the student with questions before providing answers. Do not give the answer directly until the student has genuinely tried.

**Adaptive explanations (Teach mode):** When a student asks you to explain a concept or "what is X", before explaining, ask ONE short calibration question to understand where they are — e.g. "What's your current understanding of X?" or "Where specifically are you stuck?" Use this to tailor the depth and framing of your explanation.

However, skip the calibration question and explain directly at the right level if you already have evidence of what they know:
- The learning profile or current weak-topics list shows their familiarity with this concept
- Their mastery score for this topic is already recorded (≥60% means they have a working foundation)
- Uploaded course files or the current conversation make their level obvious
- The question itself signals their level clearly (e.g. asking about the chain rule's proof implies they already know what a derivative is)

Never ask calibration questions that the context has already answered. One well-placed question beats a questionnaire.`,

  focus: `Proactively steer the conversation toward the student's weakest topics. After answering, follow up with a related question about a weak area.

**Adaptive explanations (Focus mode):** Same as Teach — when a student asks you to explain a concept, ask ONE calibration question first to tailor your response, unless the wiki, mastery scores, uploaded files, or the conversation itself already tell you what they know. Use that context to calibrate depth and framing, not to ask what you already know. Skip calibration and explain at the appropriate level when the evidence is clear.`,
}

export type AssistanceLevel = 'feedback' | 'suggest' | 'assist'

const COURSE_TYPE_ESSAY_FOCUS: Record<string, string> = {
  humanities: 'Focus on argumentation, thesis strength, evidence use, and citation style.',
  social_science: 'Focus on research framing, methodology clarity, and data interpretation.',
  quantitative: 'Focus on technical precision, logical structure, and clarity of proof or derivation.',
  professional: 'Focus on technical precision, logical structure, and clarity of proof or derivation.',
  conceptual_science: 'Focus on general academic writing: structure, clarity, and argument coherence.',
  language: 'Focus on general academic writing: structure, clarity, and argument coherence.',
}

function buildEssaySection(level: AssistanceLevel, courseType?: string): string {
  const focus = courseType ? (COURSE_TYPE_ESSAY_FOCUS[courseType] ?? COURSE_TYPE_ESSAY_FOCUS.conceptual_science) : 'Focus on general academic writing: structure, clarity, and argument coherence.'

  const levelRules =
    level === 'feedback'
      ? `**Feedback Only** — NEVER call suggest_edit. Your job is to ask questions and give verbal feedback only. Be Socratic: ask "What are you arguing here?" or "How does this support your thesis?" before explaining anything. Guide the student to their own improvements.`
      : level === 'suggest'
      ? `**Suggest** — Give direct feedback in chat AND call suggest_edit to show the student a concrete improvement. You MUST call suggest_edit at least once per response when the student has written content — do not just give verbal feedback and leave. Keep edits small: maximum 2 new sentences per suggest_edit call. Show the change, then explain in chat why you made it.`
      : `**Full Assist** — Act first, explain after. When the student makes any request (expand, rewrite, improve, fix), immediately call suggest_edit with the edit, then explain your reasoning in chat. NEVER ask the student questions before acting — do the work, then tell them what you did and why. Maximum 1 paragraph per suggest_edit call. If you disagree with a request, still make your best version of what they asked for, then note your concern after.`

  return `
## Essay mode
The student is writing an essay. The current essay content is injected at the top of each message as [Current essay content].

${focus}

**Assistance level (this controls both your chat style AND editing permissions):**
${levelRules}

**Guardrails:**
- The student must have written at least one paragraph before you call suggest_edit.
- If asked to write on a blank page, decline: "What point are you trying to make here? Let's build it together."
- Never write an entire essay section unprompted.
- Ignore the Answer/Teach/Focus mode in essay mode — the assistance level above governs everything.`
}

export async function buildTutorSystemPrompt(
  userId: string,
  courseId: string,
  courseName: string,
  mode: TutorMode,
  opts?: { essayMode?: boolean; assistanceLevel?: AssistanceLevel; courseType?: string; professorId?: string; ragContext?: string; topics?: { topic_id: string; name: string }[]; isSessionOpen?: boolean }
): Promise<{ static: string; rag: string; dynamic: string }> {
  const service = createServiceClient()

  const [learningProfile, professorWiki, courseMemory] = await Promise.all([
    readWikiFile(userId, 'learning_profile.md'),
    opts?.professorId ? readWikiFile(userId, `professor_${opts.professorId}.md`) : Promise.resolve(null),
    getCourseMemory(userId, courseId).catch(() => null),
  ])

  const { data: mastery } = await service
    .from('topic_mastery')
    .select('mastery_score, topics(name)')
    .eq('user_id', userId)
    .order('mastery_score', { ascending: true })
    .limit(10)

  const weakTopics = (mastery ?? [])
    .map((m: { mastery_score: number | null; topics: { name: string } | null }) => {
      const topic = m.topics
      return topic ? `- ${topic.name} (${Math.round(Number(m.mastery_score ?? 0) * 100)}%)` : null
    })
    .filter(Boolean)
    .join('\n')

  const verificationSection = mode !== 'answer' ? `
## Verification questions
When a student expresses uncertainty about a topic despite appearing to understand it, ask ONE clear professor-style question in your response text to check their actual grasp. When the student answers that question in their next message, call grade_answer with a score 0.0–1.0:
- 0.0–0.3: poor understanding — tell the student plainly and re-explain
- 0.4–0.6: partial understanding — identify exactly what's missing
- 0.7–1.0: strong understanding — acknowledge it and explore why they felt uncertain
Only call grade_answer when you explicitly posed a verification question and the student has answered it.` : `
## Answer mode — no verification questions
Do NOT ask verification or check-your-understanding questions. The student wants direct answers. Just answer clearly and move on.`

  const essaySection = opts?.essayMode ? buildEssaySection(opts.assistanceLevel ?? 'suggest', opts.courseType) : ''

  const topicsSection = opts?.topics && opts.topics.length > 0
    ? `\n## Course topics (use these IDs when creating artifacts)\nWhen calling create_flashcards or create_quiz, set topic_id to the ID of the best-matching topic from this list. Pick the closest match — if nothing fits well, use the most general relevant topic.\n\n${opts.topics.map(t => `- ${t.topic_id} — ${t.name}`).join('\n')}`
    : ''

  // C1: the RAG excerpts are returned as their OWN block so the route can mark
  // them with cache_control — within a turn's tool-loop iterations (up to 5 API
  // calls) and across follow-up turns on the same topic, the chunks are
  // byte-identical, so this turns the largest repeated payload after history
  // into cache reads instead of full-price input tokens.
  const ragBlock = opts?.ragContext
    ? `## Retrieved course material\nThe following excerpts come directly from the student's uploaded course files. Treat this as authoritative — it overrides your general knowledge. Do NOT contradict, second-guess, or "correct" information found here based on what you think is standard. If the file says something unusual (e.g. a non-standard constant, a professor-specific rule), trust it and relay it accurately.\n\n${clampBlock('rag', opts.ragContext)}`
    : ''

  const professorSection = professorWiki
    ? `\n## Professor profile\nThis is what is known about the professor who teaches ${courseName}. Use this to tailor explanations, anticipate exam-style questions, and calibrate depth to how this professor tests.\n\n${clampBlock('professor', professorWiki)}`
    : ''

  // M2 + M5: the rolling per-course memory digest, plus an explicit instruction
  // to open with a one-line recap when this is the first message of a session —
  // memory the student can't perceive feels like no memory.
  const memorySection = courseMemory?.digest
    ? `\n## What you remember about this student in this course\nBuilt from your previous sessions together. Use it for continuity — reference prior work naturally, don't re-teach what they've mastered, and watch for their known confusions.\n\n${clampBlock('course_memory', courseMemory.digest)}${opts?.isSessionOpen ? `\n\nThis is the FIRST message of a new session: open your reply with ONE short line of continuity (e.g. "Welcome back — last time X tripped you up; want to pick that up or start fresh?") before addressing their message. Keep it to a single line; skip it if their message clearly starts something unrelated.` : ''}`
    : ''

  // ── STATIC block — identical for EVERY student, course, mode, and turn. The route
  // marks this with cache_control, so it must contain NO per-course / per-mode /
  // per-session text or the prompt cache never hits. (All dynamic text lives in the
  // dynamic block below, appended after the cache breakpoint.)
  const staticBlock = `You are an expert tutor helping a college student study their course. You have access to their uploaded course materials and mastery data.

## Tone and honesty
- Respond directly and clearly. No filler phrases like "Great question!" or "Certainly!".
- No emojis. Ever.
- Do not fabricate information. If you are not certain about something, say so explicitly: "I'm not sure about this — verify with your notes or professor."
- Be blunt and constructive. If the student's answer or reasoning is wrong, say so plainly and explain why.
- Be friendly but not performative. Treat the student as a capable adult.
- Use proper markdown formatting in all responses: headings, bullet points, bold, code blocks, tables where appropriate. Never write a wall of plain text.

## Wiki patterns
Call write_wiki_pattern ONLY when you observe a durable, non-obvious pattern about how this student learns — something genuinely useful for future sessions. Examples: a systematic misconception that keeps recurring, a topic they struggle with despite repeated practice, a learning approach they've expressed. Do NOT write for routine interactions. Quality over quantity.

## Web search
You have access to a web_search tool. Use it ONLY when:
- The question requires up-to-date information not in the course materials
- The student explicitly asks you to look something up
Always prefer course materials first. Only search for information directly relevant to the student's current course.

## Visuals and diagrams
You have two ways to show visuals — use the right one for the job:

**Mermaid diagrams** — write a \`\`\`mermaid code block. It renders automatically as a visual diagram inline in the chat. Use for processes, sequences, concept maps, flowcharts, and relationships between ideas. Examples: the steps of mitosis, how a for-loop executes, how action potentials propagate, cause-and-effect chains in history, class relationships in OOP.

**create_chart tool** — renders a bar, line, or pie chart directly in the chat. Use for quantitative data — comparisons, trends, distributions, function plots. Examples: exam topic frequency by professor weight, sin(x) over 0–2π, grade score distributions. Do NOT use charts for processes or relationships — that's what Mermaid is for.

Offer visuals naturally when they would genuinely help. Don't force them. A good diagram beats a paragraph every time when showing a process or relationship. A chart beats a table when the pattern in numbers is the point.

## Artifacts you can generate
You can open visual artifacts in the student's split view by calling the right tool. Know what you have and offer them proactively when they'd help:
- **create_flashcards** — spaced-repetition deck on one topic. Best after explaining definitions, formulas, vocabulary, or a discrete body of facts the student needs to memorize.
- **create_quiz** — practice quiz (MC / short answer / mixed). Best after working through a concept to test whether understanding stuck, or when the student wants to self-assess on a topic or weak area.
- **open_essay_mode** — split-view essay editor with tracked-change suggestions. Call IMMEDIATELY whenever the student mentions a paper, essay, report, or written assignment.

When the student says yes to an offer, generate immediately — follow each tool's own description for any quick clarifying questions (format, count, subtopic). You MAY call create_flashcards and create_quiz in the same turn if the student asks for both — they will stack as separate chips in the chat and both remain accessible.

**Artifact persistence:** Every artifact you create leaves a chip in the chat (e.g. "10 flashcards — Derivatives"). Those chips stay in place for the whole session and the student can tap them any time to re-open that specific artifact. If the student asks to get an earlier deck or quiz back, tell them to scroll up and tap the chip on the message where you created it — do NOT say you can't access previously-made artifacts. They're always still there.

## Guardrails
- If a question references material not in the uploaded files, say so. Do not invent content.
- When a student asks for help with an essay or paper, immediately call open_essay_mode — do not refuse. You help them write, you do not ghostwrite for them. The distinction is made inside essay mode.`

  // ── DYNAMIC block — everything that varies by course / mode / student / turn.
  // Appended AFTER the cache breakpoint, so it never busts the cached static prefix.
  const dynamicBlock = `You are tutoring **${courseName}** for this student.

## Behaviour
${MODE_INSTRUCTIONS[mode]}

## How strongly to recommend practice, by mode
- **Answer mode** (${mode === 'answer' ? 'CURRENT' : 'not active'}): Low-pressure. If a topic naturally invites practice, drop ONE line at the end — "Want a quick quiz to check this?" — and move on. Don't push if the student keeps asking questions.
- **Teach mode** (${mode === 'teach' ? 'CURRENT' : 'not active'}): Practice is core to the Socratic loop. Once the student has demonstrated understanding through your guiding questions, confidently offer a quiz or flashcards: "You've got it — let's lock it in with 5 questions." Expect to close most successful teaching exchanges with this.
- **Focus mode** (${mode === 'focus' ? 'CURRENT' : 'not active'}): Aggressively steer the student toward their weakest topics using these tools. End most responses by offering flashcards or a quiz specifically on a weak area from the list below. This is the primary way Focus mode earns its name — not just mentioning weak areas, but acting on them.

## Context
${clampBlock('learning_profile', learningProfile)}
${weakTopics ? `\nCurrent weak areas:\n${clampBlock('weak_topics', weakTopics)}` : ''}
${memorySection}
${professorSection}
${clampBlock('topics_list', topicsSection)}
${verificationSection}

## Course guardrail
- Only answer questions about ${courseName}. Accept common abbreviations, full names, and synonyms (e.g. "calc" and "Calculus" are the same). For a clearly unrelated course: "I'm focused on ${courseName} right now. Switch courses to discuss that."

Current mode: ${mode}
${essaySection}`

  return { static: staticBlock, rag: ragBlock, dynamic: dynamicBlock }
}

export async function createSession(
  userId: string,
  courseId: string,
  mode: TutorMode
): Promise<string> {
  const service = createServiceClient()
  const { data: newSession, error } = await service
    .from('session_log')
    .insert({ user_id: userId, course_id: courseId, mode })
    .select('session_id')
    .single()

  if (error || !newSession) throw new Error(error?.message ?? 'Failed to create session')
  return newSession!.session_id
}

export async function getOrCreateSession(
  userId: string,
  courseId: string,
  mode: TutorMode
): Promise<string> {
  const service = createServiceClient()

  // Check for an existing open session today
  const { data: userRow } = await service
    .from('users')
    .select('timezone')
    .eq('user_id', userId)
    .single()
  const tz = userRow?.timezone ?? 'UTC'
  const today = dateKeyInTimeZone(new Date(), tz)
  const dayStart = startOfLocalDayUtc(today, tz).toISOString()
  const { data: existing } = await service
    .from('session_log')
    .select('session_id')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .gte('created_at', dayStart)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle() // .single() errors on zero rows — maybeSingle is the correct "find or none"

  if (existing) return existing.session_id

  return createSession(userId, courseId, mode)
}

export async function listUserSessions(userId: string) {
  const service = createServiceClient()
  const { data } = await service
    .from('session_log')
    .select('session_id, course_id, name, mode, created_at, essay_content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)
  return data ?? []
}

export async function getSessionMessages(sessionId: string) {
  const service = createServiceClient()
  const { data } = await service
    .from('session_messages')
    .select('role, content, inline_card')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  return data ?? []
}

export async function getOwnedSessionMessages(sessionId: string, userId: string) {
  const service = createServiceClient()
  const { data } = await service
    .from('session_messages')
    .select('role, content, inline_card')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  return data ?? []
}

export async function saveMessage(
  sessionId: string,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  inlineCard?: object | object[] | null,
): Promise<string | null> {
  const service = createServiceClient()
  const { data: session } = await service
    .from('session_log')
    .select('session_id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .single()
  if (!session) throw new Error('Session not found')
  const hasCard = inlineCard != null && (!Array.isArray(inlineCard) || inlineCard.length > 0)
  const { data: inserted } = await service.from('session_messages').insert({
    session_id: sessionId,
    user_id: userId,
    role,
    content,
    ...(hasCard ? { inline_card: inlineCard } : {}),
  }).select('message_id').single()
  return inserted?.message_id ?? null
}

// Remove a persisted turn — used to roll back the user message when generation
// fails or returns empty (B7): a failed turn must not burn the daily message
// quota (it counts role='user' rows) or replay as a question with no answer.
export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const service = createServiceClient()
  await service
    .from('session_messages')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
}

export async function autoNameSession(sessionId: string, userId: string, firstExchange: string, apiKey: string) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey })

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `Generate a 2-4 word title for a study session that started with this exchange:\n\n${firstExchange.slice(0, 300)}\n\nRespond with ONLY the title, no quotes or punctuation.`,
      }],
    })

    const name = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (name) {
      const service = createServiceClient()
      await service
        .from('session_log')
        .update({ name })
        .eq('session_id', sessionId)
        .eq('user_id', userId)
    }
  } catch {
    // Non-critical
  }
}
