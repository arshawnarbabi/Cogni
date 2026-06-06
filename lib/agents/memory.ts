import Anthropic from '@anthropic-ai/sdk'
import { after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { withRetry } from '@/lib/ai/call'
import { resolveTopicByName, applyMasteryEvidence, LEARNING_RATES, type EvidenceInput } from '@/lib/mastery'
import { recordUsage } from '@/lib/usage'

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
  topic_signals: { topic_name: string; signal: 'understood' | 'struggled' }[]
  memories: { kind: 'preference' | 'misconception' | 'goal'; content: string; topic_name?: string }[]
  updated_digest: string
}

const MEMORY_KINDS = new Set(['preference', 'misconception', 'goal'])
const MAX_MEMORIES_PER_COURSE = 30

// Exported for unit tests.
export function parseDistilled(raw: string): Distilled | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  try {
    const p = JSON.parse(match ? match[0] : cleaned)
    if (typeof p.summary !== 'string' || !p.summary.trim()) return null
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [])
    const signals = Array.isArray(p.topic_signals)
      ? (p.topic_signals as { topic_name?: unknown; signal?: unknown }[])
          .filter(s => typeof s?.topic_name === 'string' && (s?.signal === 'understood' || s?.signal === 'struggled'))
          .slice(0, 10)
          .map(s => ({ topic_name: s.topic_name as string, signal: s.signal as 'understood' | 'struggled' }))
      : []
    const memories = Array.isArray(p.memories)
      ? (p.memories as { kind?: unknown; content?: unknown; topic_name?: unknown }[])
          .filter(m => typeof m?.kind === 'string' && MEMORY_KINDS.has(m.kind) && typeof m?.content === 'string' && (m.content as string).trim().length > 0)
          .slice(0, 6)
          .map(m => ({
            kind: m.kind as 'preference' | 'misconception' | 'goal',
            content: (m.content as string).trim().slice(0, 400),
            topic_name: typeof m.topic_name === 'string' ? m.topic_name : undefined,
          }))
      : []
    return {
      summary: p.summary.trim().slice(0, 1200),
      confusions: arr(p.confusions),
      understood: arr(p.understood),
      preferences: arr(p.preferences),
      topic_names: arr(p.topic_names),
      topic_signals: signals,
      memories,
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

  const [{ data: courseTopics }, oldMemory, { data: course }, { data: userRow }] = await Promise.all([
    service.from('topics').select('topic_id, name').eq('course_id', session.course_id).eq('user_id', userId),
    getCourseMemory(userId, session.course_id),
    service.from('courses').select('name').eq('course_id', session.course_id).eq('user_id', userId).maybeSingle(),
    service.from('users').select('memory_paused').eq('user_id', userId).maybeSingle(),
  ])

  // M7: the student paused memory — write nothing new (existing memory stays
  // until they delete it).
  if (userRow?.memory_paused === true) return false

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
  "topic_signals": [{"topic_name": "course topic name", "signal": "understood" | "struggled"}, ...],
  "memories": [{"kind": "preference" | "misconception" | "goal", "content": "one durable, specific fact", "topic_name": "course topic if applicable"}, ...],
  "updated_digest": "the NEW rolling course memory: merge the existing memory with this session. A running narrative of what's been covered across all sessions, persistent confusions (drop ones now resolved), and stable preferences. Write in compact prose + short bullets. HARD LIMIT ~600 words — compress older history harder than recent."
}

topic_signals rules: only include a topic when the transcript shows CLEAR evidence — the student demonstrably explained/answered it correctly ("understood") or demonstrably got it wrong / said they're lost ("struggled"). Mere exposure is NOT a signal; omit when unsure.

memories rules: durable facts only, the kind worth knowing NEXT month — a recurring misconception ("applies chain rule as product rule"), a stated preference ("wants worked examples first"), a concrete goal ("aiming for an A; final worth 40%"). NOT session events. Empty array is the right answer for most sessions.

Rules: be specific and factual — only what the transcript supports. Empty arrays are fine. No advice, no filler.`,
    }],
  }), { label: 'memory.distill', keyHealth: { userId, provider: 'anthropic' } })
  recordUsage(userId, 'memory', 'claude-haiku-4-5-20251001', response.usage)

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

  // M3: typed, machine-readable facts (vs. the prose digest) — what the
  // scheduler boosts on (M8) and what the student can edit/delete (M7).
  // Exact-content repeats bump last_seen instead of duplicating.
  for (const mem of distilled.memories) {
    const topicId = mem.topic_name
      ? resolveTopicByName(mem.topic_name, (courseTopics ?? []) as { topic_id: string; name: string }[])
      : null
    const { data: existingMem } = await service
      .from('student_memory')
      .select('memory_id')
      .eq('user_id', userId)
      .eq('course_id', session.course_id)
      .eq('kind', mem.kind)
      .eq('content', mem.content)
      .maybeSingle()
    if (existingMem) {
      await service.from('student_memory').update({ last_seen: new Date().toISOString() }).eq('memory_id', existingMem.memory_id)
    } else {
      await service.from('student_memory').insert({
        user_id: userId,
        course_id: session.course_id,
        topic_id: topicId,
        kind: mem.kind,
        content: mem.content,
        source_session_id: sessionId,
      })
    }
  }
  // Bound growth: keep the most recently seen N per course.
  const { data: allMems } = await service
    .from('student_memory')
    .select('memory_id')
    .eq('user_id', userId)
    .eq('course_id', session.course_id)
    .order('last_seen', { ascending: false })
  if ((allMems ?? []).length > MAX_MEMORIES_PER_COURSE) {
    const excess = (allMems ?? []).slice(MAX_MEMORIES_PER_COURSE).map((m: { memory_id: string }) => m.memory_id)
    await service.from('student_memory').delete().in('memory_id', excess)
  }

  // I2: the conversation IS learning evidence. Clear demonstrations of
  // understanding/struggle move mastery — at the low 'conversation' learning
  // rate, so an hour of tutoring finally changes the study plan, but one chat
  // can't swing a topic the way a graded quiz does.
  if (distilled.topic_signals.length > 0) {
    const evidences: EvidenceInput[] = []
    const seen = new Set<string>()
    for (const sig of distilled.topic_signals) {
      const topicId = resolveTopicByName(sig.topic_name, (courseTopics ?? []) as { topic_id: string; name: string }[])
      if (!topicId || seen.has(topicId)) continue
      seen.add(topicId)
      evidences.push({
        topicId,
        observed: sig.signal === 'understood' ? 0.75 : 0.25,
        learningRate: LEARNING_RATES.conversation,
      })
    }
    if (evidences.length > 0) {
      await applyMasteryEvidence(userId, evidences).catch(e => console.error('[memory] conversation evidence failed', e))
    }
  }

  return true
}

// ── In-session history compaction (M6) ──────────────────────────────────────
// The tutor previously re-sent the ENTIRE session transcript on every turn —
// O(n²) total tokens over a long session, all on the student's key. Once the
// transcript outgrows the verbatim window, the older prefix is summarized ONCE
// (cached in session_log.history_summary / history_summary_upto) and re-used
// until enough new turns accumulate to re-summarize.

export const HISTORY_VERBATIM_WINDOW = 12  // most recent messages sent verbatim
export const HISTORY_COMPACT_TRIGGER = 20  // compact once history exceeds this
const HISTORY_RESUMMARIZE_SLACK = 6        // re-summarize after this many newly-evicted turns

export type CompactedHistory = {
  /** Synthetic context block describing the elided prefix ('' if none). */
  summaryBlock: string
  /** The messages to send verbatim. */
  messages: { role: string; content: string }[]
}

export async function compactHistory(
  userId: string,
  sessionId: string,
  priorMessages: { role: string; content: string }[],
  apiKey: string,
): Promise<CompactedHistory> {
  if (priorMessages.length <= HISTORY_COMPACT_TRIGGER) {
    return { summaryBlock: '', messages: priorMessages }
  }

  const service = createServiceClient()
  const evictCount = priorMessages.length - HISTORY_VERBATIM_WINDOW
  const evicted = priorMessages.slice(0, evictCount)
  const kept = priorMessages.slice(evictCount)

  const { data: session } = await service
    .from('session_log')
    .select('history_summary, history_summary_upto')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()

  const cachedUpto = session?.history_summary_upto ?? 0
  const cachedSummary = (session?.history_summary as string | null) ?? null

  // Reuse the cached summary while it still covers (most of) the evicted prefix.
  if (cachedSummary && cachedUpto >= evictCount - HISTORY_RESUMMARIZE_SLACK) {
    // Include any evicted-but-not-yet-summarized turns verbatim so nothing is lost.
    const gap = priorMessages.slice(Math.min(cachedUpto, evictCount), evictCount)
    return { summaryBlock: cachedSummary, messages: [...gap, ...kept] }
  }

  // (Re-)summarize the evicted prefix in the BACKGROUND — a synchronous Haiku
  // call here gated the student's FIRST STREAMED TOKEN behind seconds of
  // summarization. Serve the verbatim transcript now (correct, just costlier);
  // the cached brief this writes shrinks the NEXT turn. after() keeps the
  // lambda alive past the response on Vercel (same pattern as kickJobs).
  const summarize = async () => {
    try {
      const client = new Anthropic({ apiKey })
      const newPart = renderTranscript(evicted.slice(cachedSummary ? cachedUpto : 0))
      const response = await withRetry(() => client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: `Compress this tutoring-session history into a compact "conversation so far" brief (max ~250 words). Preserve: concepts covered and conclusions reached, what the student got right/wrong, unresolved questions, and any commitments ("we'll do a quiz next"). Drop pleasantries and redundancy.

${cachedSummary ? `EXISTING BRIEF (covers the earlier part):\n${cachedSummary}\n\nNEW TURNS TO FOLD IN:` : 'TRANSCRIPT:'}
${newPart}

Return ONLY the updated brief text.`,
        }],
      }), { label: 'memory.compact', keyHealth: { userId, provider: 'anthropic' } })
      recordUsage(userId, 'memory', 'claude-haiku-4-5-20251001', response.usage)

      const summary = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
      if (summary) {
        await service.from('session_log').update({
          history_summary: summary.slice(0, 4000),
          history_summary_upto: evictCount,
          updated_at: new Date().toISOString(),
        }).eq('session_id', sessionId).eq('user_id', userId)
      }
    } catch (e) {
      console.error('[memory] background history compaction failed', e)
    }
  }
  try {
    after(summarize)
  } catch {
    void summarize()
  }

  // This turn ships the full transcript verbatim; the brief lands for next turn.
  return { summaryBlock: '', messages: priorMessages }
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
