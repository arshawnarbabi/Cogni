import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { withRetry } from '@/lib/ai/call'
import { resolveTopicByName } from '@/lib/mastery'

// ─────────────────────────────────────────────────────────────────────────────
// Persistent tutor memory (M1 + M2 + M9).
//
// Today every tutor session starts from zero: getOwnedSessionMessages only
// returns the CURRENT session, so what was covered, what confused the student,
// and their stated preferences all evaporate overnight. This module turns each
// finished session into ~150 tokens of durable memory:
//
//   distillSession()  — ONE Haiku call over the transcript → a structured
//                       digest row in session_summaries (episodic memory),
//                       fills the previously-dead session_log.topics_discussed
//                       + duration_seconds columns, and folds the session into
//                       the rolling per-course digest (below) in the SAME call.
//
//   course_memory     — ONE capped digest per (user, course): a running
//                       narrative of what's been covered, persistent
//                       confusions, and preferences. O(1) prompt tokens per
//                       request no matter how many sessions exist; injected
//                       into the tutor's dynamic block (it is per-course, so it
//                       belongs below the cache breakpoint).
//
// Cost: one Haiku call per session close, on the student's own key. Triggered
// as a 'distill' job ~45 min after the session's last message (re-armed on each
// new message), with a lazy inline fallback when the student opens a new
// session before the job ran.
// ─────────────────────────────────────────────────────────────────────────────

// ~800 tokens — the hard cap that keeps per-request memory cost flat (F2).
export const DIGEST_CHAR_BUDGET = 3200
// Transcript slice sent to the distiller: plenty for a study session, bounded
// for cost. First exchanges + the tail carry the most signal.
const TRANSCRIPT_HEAD = 4000
const TRANSCRIPT_TAIL = 20000

export type CourseMemory = {
  digest: string
  updated_at: string
}

export async function getCourseMemory(userId: string, courseId: string): Promise<CourseMemory | null> {
  const service = createServiceClient()
  const { data } = await service
    .from('course_memory')
    .select('digest, updated_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .maybeSingle()
  return data ?? null
}

function renderTranscript(messages: { role: string; content: string }[]): string {
  const lines = messages.map(m => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content.replace(/^\[att:[^\]]+\]\n/, '')}`)
  const full = lines.join('\n\n')
  if (full.length <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL) return full
  return `${full.slice(0, TRANSCRIPT_HEAD)}\n\n[... middle of session omitted ...]\n\n${full.slice(-TRANSCRIPT_TAIL)}`
}

type Distilled = {
  summary: string
  confusions: string[]
  understood: string[]
  preferences: string[]
  topic_names: string[]
  updated_digest: string
}

// Exported for unit tests.
export function parseDistilled(raw: string): Distilled | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  try {
    const p = JSON.parse(match ? match[0] : cleaned)
    if (typeof p.summary !== 'string' || !p.summary.trim()) return null
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [])
    return {
      summary: p.summary.trim().slice(0, 1200),
      confusions: arr(p.confusions),
      understood: arr(p.understood),
      preferences: arr(p.preferences),
      topic_names: arr(p.topic_names),
      updated_digest: typeof p.updated_digest === 'string' ? p.updated_digest.trim().slice(0, DIGEST_CHAR_BUDGET) : '',
    }
  } catch {
    return null
  }
}

/**
 * Distill one finished session into durable memory. Idempotent: skips if a
 * summary already exists for the session. Returns true if memory was written.
 */
export async function distillSession(userId: string, sessionId: string): Promise<boolean> {
  const service = createServiceClient()

  const { data: session } = await service
    .from('session_log')
    .select('session_id, course_id, created_at')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!session) return false

  // Idempotency: one summary per session.
  const { data: existing } = await service
    .from('session_summaries')
    .select('summary_id')
    .eq('session_id', sessionId)
    .maybeSingle()
  if (existing) return false

  const { data: messages } = await service
    .from('session_messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  const msgs = (messages ?? []) as { role: string; content: string; created_at: string }[]
  const userTurns = msgs.filter(m => m.role === 'user').length
  // A drive-by single question isn't worth a durable memory entry.
  if (userTurns < 2) return false

  const apiKey = await getUserApiKey(userId)
  if (!apiKey) return false

  const [{ data: courseTopics }, oldMemory, { data: course }] = await Promise.all([
    service.from('topics').select('topic_id, name').eq('course_id', session.course_id).eq('user_id', userId),
    getCourseMemory(userId, session.course_id),
    service.from('courses').select('name').eq('course_id', session.course_id).eq('user_id', userId).maybeSingle(),
  ])

  const client = new Anthropic({ apiKey })
  const response = await withRetry(() => client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You maintain a study-memory system for a student. Distill this tutoring session for the course "${course?.name ?? 'their course'}" AND fold it into their rolling course memory.

${oldMemory?.digest ? `EXISTING COURSE MEMORY (everything before this session):\n${oldMemory.digest}\n` : 'No existing course memory — this is the first remembered session.'}

SESSION TRANSCRIPT:
${renderTranscript(msgs)}

Return ONLY valid JSON (no markdown fences):
{
  "summary": "2-3 sentences: what was worked on and how it went",
  "confusions": ["specific things the student got wrong or said confused them", ...],
  "understood": ["specific things the student demonstrably got right", ...],
  "preferences": ["explicitly stated study/explanation preferences, if any", ...],
  "topic_names": ["course topic names touched in this session", ...],
  "updated_digest": "the NEW rolling course memory: merge the existing memory with this session. A running narrative of what's been covered across all sessions, persistent confusions (drop ones now resolved), and stable preferences. Write in compact prose + short bullets. HARD LIMIT ~600 words — compress older history harder than recent."
}

Rules: be specific and factual — only what the transcript supports. Empty arrays are fine. No advice, no filler.`,
    }],
  }), { label: 'memory.distill', keyHealth: { userId, provider: 'anthropic' } })

  const raw = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const distilled = parseDistilled(raw)
  if (!distilled) {
    console.error('[memory] distill parse failed for session', sessionId)
    return false
  }

  const topicIds = distilled.topic_names
    .map(name => resolveTopicByName(name, (courseTopics ?? []) as { topic_id: string; name: string }[]))
    .filter((id): id is string => !!id)
  const uniqueTopicIds = [...new Set(topicIds)]

  const first = msgs[0]?.created_at
  const last = msgs[msgs.length - 1]?.created_at
  const durationSeconds = first && last
    ? Math.max(0, Math.round((new Date(last).getTime() - new Date(first).getTime()) / 1000))
    : null

  const { error: summaryError } = await service.from('session_summaries').upsert({
    user_id: userId,
    session_id: sessionId,
    course_id: session.course_id,
    summary: distilled.summary,
    confusions: distilled.confusions,
    understood: distilled.understood,
    preferences: distilled.preferences,
    topics_discussed: uniqueTopicIds.length > 0 ? uniqueTopicIds : null,
    message_count: msgs.length,
  }, { onConflict: 'session_id', ignoreDuplicates: true })
  if (summaryError) {
    console.error('[memory] session_summaries upsert failed', summaryError)
    return false
  }

  // M9: fill the previously-dead session_log columns.
  await service.from('session_log').update({
    topics_discussed: uniqueTopicIds.length > 0 ? uniqueTopicIds : null,
    duration_seconds: durationSeconds,
    updated_at: new Date().toISOString(),
  }).eq('session_id', sessionId).eq('user_id', userId)

  // M2: the rolling per-course digest (capped → O(1) prompt tokens forever).
  if (distilled.updated_digest) {
    await service.from('course_memory').upsert({
      user_id: userId,
      course_id: session.course_id,
      digest: distilled.updated_digest.slice(0, DIGEST_CHAR_BUDGET),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,course_id' })
  }

  return true
}

/**
 * Lazy fallback for session-open (M5): if the student's most recent OTHER
 * session for this course was never distilled (the 45-min job hasn't drained —
 * e.g. first visit of the day on a daily-cron deploy) and has been idle for
 * 2h+, distill it NOW so the recap the tutor is about to give includes it.
 * Bounded to one session, ~1 Haiku call worst case.
 */
export async function distillPreviousSessionIfNeeded(
  userId: string,
  courseId: string,
  currentSessionId: string,
): Promise<void> {
  const service = createServiceClient()
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  const { data: candidates } = await service
    .from('session_log')
    .select('session_id, created_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .neq('session_id', currentSessionId)
    .lt('created_at', twoHoursAgo)
    .order('created_at', { ascending: false })
    .limit(3)

  for (const c of (candidates ?? []) as { session_id: string }[]) {
    const { data: summarized } = await service
      .from('session_summaries')
      .select('summary_id')
      .eq('session_id', c.session_id)
      .maybeSingle()
    if (!summarized) {
      await distillSession(userId, c.session_id).catch(e => console.error('[memory] lazy distill failed', e))
      return // at most one inline distill — latency-bounded
    }
    return // most recent prior session is already distilled — nothing to do
  }
}
