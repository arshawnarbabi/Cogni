import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyMcpToken, type McpAuthInfo } from '@/lib/mcp/auth'
import { mcpGuard, consumeMcpWrite, auditMcpCall } from '@/lib/mcp/guards'
import { retrieveChunksDetailed } from '@/lib/rag'
import { readWikiFile } from '@/lib/wiki'
import { newCardDefaults, scheduleReview } from '@/lib/fsrs'
import { assignNewCardDueDates } from '@/lib/agents/flashcard'
import { applyMasteryEvidence, flashcardObserved, effectiveMastery, LEARNING_RATES } from '@/lib/mastery'
import { bumpStudyStreak } from '@/lib/streak'
import { DIGEST_CHAR_BUDGET } from '@/lib/agents/memory'
import { runScheduler, type TaskItem } from '@/lib/agents/scheduler'
import { dateKeyInTimeZone, isValidTimeZone } from '@/lib/time'
import crypto from 'node:crypto'

export const runtime = 'nodejs'
export const maxDuration = 60

// The Cogni MCP server. A student connects their own Claude client (Claude Code /
// Desktop) and these tools let Claude read + act on THEIR Cogni data — same context
// and actions the in-app tutor has — scoped to the authenticated user. Inference runs
// on the user's own Claude subscription; this server only serves data.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userIdFrom(extra: any): string | null {
  const authInfo = extra?.authInfo as McpAuthInfo | undefined
  return authInfo?.extra?.userId ?? null
}

function asText(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }
}

// "Today" in the STUDENT's timezone — the same dateKeyInTimeZone convention every
// in-app due-date query uses. The MCP tools previously sliced an ISO string (UTC),
// so due counts disagreed with the app by up to a day for non-UTC users (bug B5).
// The guard already read the users row, so it passes the timezone through — only
// fall back to a SELECT if it's missing/invalid.
async function userToday(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  tz?: string | null,
): Promise<string> {
  let zone = tz
  if (!isValidTimeZone(zone)) {
    const { data } = await service.from('users').select('timezone').eq('user_id', userId).maybeSingle()
    zone = data?.timezone as string | undefined
  }
  return dateKeyInTimeZone(new Date(), isValidTimeZone(zone) ? zone as string : 'UTC')
}

// Expected tool failures (bad input, exhausted budget): audited as ok=false with
// the code, returned as the standard error envelope — distinct from unexpected
// throws which become 'internal_error'.
class McpToolError extends Error {
  constructor(public code: string, public detailText?: string) { super(code) }
}

// Every tool runs through this wrapper (F4): auth extraction, the shared guard
// (suspended / kill-switch / per-user daily quota), an audit row, and a try/catch
// so one tool failure returns a structured error instead of crashing the request.
function guarded<A>(
  tool: string,
  kind: 'read' | 'write',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: A, userId: string, tz: string | null) => Promise<any>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: A, extra: any) => {
    const userId = userIdFrom(extra)
    if (!userId) return asText({ error: 'unauthorized' })

    const { blocked, timezone } = await mcpGuard(userId, kind)
    if (blocked) {
      auditMcpCall(userId, tool, false, blocked)
      return asText({ error: blocked })
    }

    try {
      const result = await handler(args, userId, timezone)
      auditMcpCall(userId, tool, true)
      return result
    } catch (e) {
      if (e instanceof McpToolError) {
        auditMcpCall(userId, tool, false, e.code)
        return asText({ error: e.code, ...(e.detailText ? { detail: e.detailText } : {}) })
      }
      console.error(`[mcp] ${tool} failed`, e)
      auditMcpCall(userId, tool, false, e instanceof Error ? e.message : 'error')
      return asText({ error: 'internal_error', detail: 'The tool failed unexpectedly — try again.' })
    }
  }
}

const TUTOR_GUIDE = `You are tutoring this student using Cogni's tools, which give you their real course materials and mastery data. Tutor like Cogni's built-in tutor:

- Ground everything in THEIR materials: call \`search_materials\` for the relevant topic before explaining, and treat retrieved excerpts as authoritative over your general knowledge (a professor's non-standard rule wins).
- Know where they stand: use \`get_course_overview\` and \`get_weak_topics\` to focus on what matters (high professor-weight, low mastery, upcoming exams).
- Teach, don't just answer: prefer guiding questions; explain at the student's level; be blunt and constructive when they're wrong. No emojis, no filler.
- Make the study COUNT — write results back so the in-app plan stays accurate:
  - Run reviews: fetch \`get_due_cards\`, quiz the student on each card conversationally, judge their answer, and call \`review_card\` (1=Again, 2=Hard, 3=Good, 4=Easy). Unrecorded reviews don't reschedule anything.
  - After the student answers a verification question you posed, call \`grade_answer\` with the topic_id and a 0–1 score so their mastery moves.
  - After explaining a discrete body of facts, offer \`create_flashcards\` so it lands in their spaced-repetition queue.
  - At the END of the session, call \`log_study_session\` with a 2-3 sentence summary — it records the session in their Cogni history, feeds their cross-session memory, and keeps their study streak alive.
- Stay on their course. Use proper markdown. Don't fabricate — if it's not in their materials, say so.

Start by calling \`list_courses\`, then \`get_course_overview\` (and \`get_weak_topics\`) for the course they want help with.`

const handler = createMcpHandler(
  (server) => {
    // ── READ ────────────────────────────────────────────────────────────────
    server.registerTool(
      'list_courses',
      {
        title: 'List courses',
        description: "List the student's active courses (course_id + name). Call this first — the other tools need a course_id.",
        inputSchema: {},
      },
      guarded('list_courses', 'read', async (_args, userId) => {
        const service = createServiceClient()
        const { data } = await service
          .from('courses').select('course_id, name')
          .eq('user_id', userId).eq('active_status', 'active').order('created_at')
        return asText((data ?? []).map((c: { course_id: string; name: string }) => ({ course_id: c.course_id, name: c.name })))
      }),
    )

    server.registerTool(
      'get_course_overview',
      {
        title: 'Course overview',
        description: 'Topics (with mastery %), upcoming exams, and pending assignments for a course. Use it to focus tutoring on what the student actually needs.',
        inputSchema: { course_id: z.string().describe('A course_id from list_courses') },
      },
      guarded('get_course_overview', 'read', async ({ course_id }: { course_id: string }, userId, tz) => {
        const service = createServiceClient()
        const today = await userToday(service, userId, tz)
        const [topics, exams, assignments] = await Promise.all([
          service.from('topics').select('topic_id, name, professor_weight, topic_mastery(mastery_score, last_updated)').eq('user_id', userId).eq('course_id', course_id),
          service.from('exams').select('date, grade_weight').eq('user_id', userId).eq('course_id', course_id).gte('date', today).order('date'),
          service.from('assignments').select('name, due_date, completion_status').eq('user_id', userId).eq('course_id', course_id).eq('completion_status', 'pending').order('due_date'),
        ])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const topicsOut = (topics.data ?? []).map((t: any) => {
          const m = Array.isArray(t.topic_mastery) ? t.topic_mastery[0] : null
          // I1: time-decayed effective mastery — same number the app's scheduler uses.
          const eff = effectiveMastery(m?.mastery_score, m?.last_updated)
          return { topic_id: t.topic_id, name: t.name, weight: Number(t.professor_weight ?? 0.5), mastery_pct: Math.round(eff * 100) }
        })
        return asText({ topics: topicsOut, upcoming_exams: exams.data ?? [], pending_assignments: assignments.data ?? [] })
      }),
    )

    server.registerTool(
      'get_weak_topics',
      {
        title: 'Weak topics',
        description: 'The student\'s highest-leverage weak topics (high professor weight × low mastery). Steer practice here.',
        inputSchema: { course_id: z.string().optional().describe('Optional: limit to one course') },
      },
      guarded('get_weak_topics', 'read', async ({ course_id }: { course_id?: string }, userId) => {
        const service = createServiceClient()
        let q = service.from('topics').select('topic_id, name, course_id, professor_weight, topic_mastery(mastery_score, last_updated)').eq('user_id', userId)
        if (course_id) q = q.eq('course_id', course_id)
        const { data } = await q
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ranked = (data ?? []).map((t: any) => {
          const m = Array.isArray(t.topic_mastery) ? t.topic_mastery[0] : null
          const ms = effectiveMastery(m?.mastery_score, m?.last_updated) // I1: decayed
          const w = Number(t.professor_weight ?? 0.5)
          return { topic_id: t.topic_id, name: t.name, course_id: t.course_id, mastery_pct: Math.round(ms * 100), priority: w * (1 - ms) }
        }).sort((a: { priority: number }, b: { priority: number }) => b.priority - a.priority).slice(0, 8)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return asText(ranked.map((t: any) => ({ topic_id: t.topic_id, name: t.name, course_id: t.course_id, mastery_pct: t.mastery_pct })))
      }),
    )

    server.registerTool(
      'search_materials',
      {
        title: 'Search course materials (RAG)',
        description: "Semantic search over the student's UPLOADED course materials. Call this before explaining a topic and treat the results as authoritative. Returns the most relevant excerpts.",
        inputSchema: {
          course_id: z.string().describe('A course_id from list_courses'),
          query: z.string().describe('What to look up, in natural language'),
        },
      },
      guarded('search_materials', 'read', async ({ course_id, query }: { course_id: string; query: string }, userId) => {
        const { chunks, reason } = await retrieveChunksDetailed(query, course_id, userId, 6)
          .catch(() => ({ chunks: [], reason: 'rag_error' as const }))
        if (chunks.length > 0) return asText({ excerpts: chunks.map((c) => c.content) })
        // Distinct empty states → distinct guidance (previously one generic string).
        const empty: Record<string, string> = {
          no_materials: 'This course has no stored materials yet — the student needs to upload notes/syllabus in Cogni before search can ground answers.',
          no_openai_key: 'No results. The student has no OpenAI key connected, so only keyword search ran — suggest adding an OpenAI key in Cogni Settings for semantic search.',
          rag_error: 'Search is temporarily unavailable (retrieval error) — answer from course overview data and say material search is down right now.',
          nothing_relevant: 'No course material matched this query. The topic may not be covered in the uploaded materials — say so rather than inventing content.',
        }
        return asText(empty[reason] ?? empty.nothing_relevant)
      }),
    )

    server.registerTool(
      'get_due_cards',
      {
        title: 'Due flashcards',
        description: 'Flashcards the student has due for review today (optionally for one course). Useful for running a quick review.',
        inputSchema: { course_id: z.string().optional() },
      },
      guarded('get_due_cards', 'read', async ({ course_id }: { course_id?: string }, userId, tz) => {
        const service = createServiceClient()
        const today = await userToday(service, userId, tz)
        let q = service.from('flashcards').select('card_id, front, back, hint, course_id, topic_id').eq('user_id', userId).lte('fsrs_next_review_date', today).limit(50)
        if (course_id) q = q.eq('course_id', course_id)
        const { data } = await q
        return asText({ due_count: (data ?? []).length, cards: data ?? [] })
      }),
    )

    // ── WRITE ───────────────────────────────────────────────────────────────
    server.registerTool(
      'create_flashcards',
      {
        title: 'Create flashcards',
        description: 'Create spaced-repetition flashcards for a topic. They are saved to the student\'s Cogni account and enter their review queue immediately.',
        inputSchema: {
          course_id: z.string().describe('A course_id from list_courses'),
          topic_id: z.string().describe('A topic_id from get_course_overview (the best-matching topic)'),
          cards: z.array(z.object({
            front: z.string().describe('Question / prompt'),
            back: z.string().describe('Answer'),
            hint: z.string().optional(),
          })).min(1).max(20).describe('1–20 cards'),
        },
      },
      guarded('create_flashcards', 'write', async (
        { course_id, topic_id, cards }: { course_id: string; topic_id: string; cards: { front: string; back: string; hint?: string }[] },
        userId,
        guardTz,
      ) => {
        const service = createServiceClient()
        // Verify the topic belongs to this user + course (don't trust client IDs).
        const { data: topic } = await service.from('topics').select('topic_id').eq('topic_id', topic_id).eq('user_id', userId).eq('course_id', course_id).maybeSingle()
        if (!topic) throw new McpToolError('topic_not_found', 'topic_id must belong to the given course_id (call get_course_overview).')

        // Burn the write budget only AFTER validation — a rejected request must
        // not eat the daily allowance.
        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        // Pace new cards through the same daily-introduction budget the in-app
        // generator uses — previously MCP cards all landed due-today (B11),
        // dumping a wall of cards on the student.
        const tz = isValidTimeZone(guardTz) ? guardTz as string : 'UTC'
        const dueDates = await assignNewCardDueDates(service, userId, cards.length, tz)

        const defaults = newCardDefaults()
        const { error } = await service.from('flashcards').insert(
          cards.map((c, i) => ({
            user_id: userId, course_id, topic_id,
            front: c.front, back: c.back, hint: c.hint ?? null,
            ...defaults,
            fsrs_next_review_date: dueDates[i],
          })),
        )
        if (error) throw new McpToolError('insert_failed')
        // Count against the REAL today — when today's new-card budget is already
        // full, dueDates[0] is tomorrow and the old count was wrong.
        const todayKey = dateKeyInTimeZone(new Date(), tz)
        const dueToday = dueDates.filter((d) => d === todayKey).length
        return asText({ created: cards.length, message: `${cards.length} flashcards saved to Cogni (${dueToday} enter the review queue today; the rest are paced over the coming days).` })
      }),
    )

    server.registerTool(
      'get_learning_profile',
      {
        title: 'Learning profile',
        description: "The durable notes Cogni keeps about how this student learns (strengths, recurring misconceptions). Use it to calibrate your explanations.",
        inputSchema: {},
      },
      guarded('get_learning_profile', 'read', async (_args, userId) => {
        const profile = await readWikiFile(userId, 'learning_profile.md').catch(() => null)
        return asText(profile || 'No learning profile yet — it builds up as the student studies.')
      }),
    )

    server.registerTool(
      'review_card',
      {
        title: 'Record a flashcard review',
        description: "Record the student's rating for a flashcard (1=Again, 2=Hard, 3=Good, 4=Easy). Updates FSRS scheduling AND topic mastery in Cogni — call this after quizzing the student on each card from get_due_cards, so the review session actually counts (reschedules the card, moves their mastery, keeps the in-app queue accurate).",
        inputSchema: {
          card_id: z.string().describe('A card_id from get_due_cards'),
          rating: z.number().int().min(1).max(4).describe('1=Again (failed), 2=Hard, 3=Good, 4=Easy'),
        },
      },
      guarded('review_card', 'write', async (
        { card_id, rating }: { card_id: string; rating: number },
        userId,
        guardTz,
      ) => {
        const service = createServiceClient()
        const { data: card } = await service
          .from('flashcards')
          .select('card_id, fsrs_stability, fsrs_difficulty, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_last_review, fsrs_next_review_date')
          .eq('card_id', card_id)
          .eq('user_id', userId)
          .maybeSingle()
        if (!card) throw new McpToolError('card_not_found', 'card_id must come from get_due_cards.')

        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        const tz = isValidTimeZone(guardTz) ? guardTz as string : 'UTC'
        const r = rating as 1 | 2 | 3 | 4
        const next = scheduleReview({
          fsrs_stability: Number(card.fsrs_stability),
          fsrs_difficulty: Number(card.fsrs_difficulty),
          fsrs_reps: card.fsrs_reps,
          fsrs_lapses: card.fsrs_lapses,
          fsrs_state: card.fsrs_state,
          fsrs_last_review: card.fsrs_last_review,
          fsrs_next_review_date: card.fsrs_next_review_date,
        }, r, tz)

        // Same atomic RPC + evidence model as the in-app review route (F3/B6).
        const { error } = await service.rpc('review_card_atomic', {
          p_card_id: card_id,
          p_user_id: userId,
          p_fsrs_stability: next.fsrs_stability,
          p_fsrs_difficulty: next.fsrs_difficulty,
          p_fsrs_reps: next.fsrs_reps,
          p_fsrs_lapses: next.fsrs_lapses,
          p_fsrs_state: next.fsrs_state,
          p_fsrs_last_review: next.fsrs_last_review,
          p_fsrs_next_review_date: next.fsrs_next_review_date,
          p_observed: flashcardObserved(r),
          p_learning_rate: LEARNING_RATES.flashcard_base,
          p_rating: r,
          p_client_review_id: crypto.randomUUID(),
        })
        if (error) throw new McpToolError('review_failed')
        return asText({ ok: true, next_due: next.fsrs_next_review_date, message: `Recorded. This card comes back ${next.fsrs_next_review_date}.` })
      }),
    )

    server.registerTool(
      'grade_answer',
      {
        title: 'Grade a verification answer',
        description: "Record how well the student understood a topic (0.0–1.0) after they answered a question you posed. Moves their Cogni mastery score — without this, an hour of tutoring changes nothing in their study plan. Use topic_id from get_course_overview / get_weak_topics.",
        inputSchema: {
          topic_id: z.string().describe('A topic_id from get_course_overview'),
          score: z.number().min(0).max(1).describe('0.0 = no understanding, 1.0 = complete understanding'),
        },
      },
      guarded('grade_answer', 'write', async (
        { topic_id, score }: { topic_id: string; score: number },
        userId,
      ) => {
        const service = createServiceClient()
        const { data: topic } = await service
          .from('topics').select('topic_id, name')
          .eq('topic_id', topic_id).eq('user_id', userId).maybeSingle()
        if (!topic) throw new McpToolError('topic_not_found', 'topic_id must come from get_course_overview / get_weak_topics.')

        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        // Same evidence model + learning rate as the in-app tutor's grade_answer.
        const [applied] = await applyMasteryEvidence(userId, [{
          topicId: topic_id,
          observed: Math.min(1, Math.max(0, score)),
          learningRate: LEARNING_RATES.tutor_grade,
        }])
        return asText({
          ok: true,
          topic: topic.name,
          mastery_before_pct: Math.round(applied.oldScore * 100),
          mastery_now_pct: Math.round(applied.newScore * 100),
        })
      }),
    )

    server.registerTool(
      'log_study_session',
      {
        title: 'Log this study session to Cogni',
        description: "Call at the END of a tutoring/study session: records it in the student's Cogni history, feeds their cross-session memory, and keeps their study streak alive. Without this, study done here is invisible in the app.",
        inputSchema: {
          course_id: z.string().describe('A course_id from list_courses'),
          summary: z.string().min(10).max(2000).describe('2-3 sentences: what was covered, what the student struggled with, what they got right'),
          topic_ids: z.array(z.string()).max(12).optional().describe('topic_ids touched this session (from get_course_overview)'),
          minutes: z.number().int().positive().max(600).optional().describe('approximate session length in minutes'),
        },
      },
      guarded('log_study_session', 'write', async (
        { course_id, summary, topic_ids, minutes }: { course_id: string; summary: string; topic_ids?: string[]; minutes?: number },
        userId,
      ) => {
        const service = createServiceClient()
        const { data: course } = await service
          .from('courses').select('course_id, name')
          .eq('course_id', course_id).eq('user_id', userId).maybeSingle()
        if (!course) throw new McpToolError('course_not_found', 'course_id must come from list_courses.')

        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        // Validate topic ids against THIS user+course (never trust client ids).
        let validTopicIds: string[] = []
        if (topic_ids && topic_ids.length > 0) {
          const { data: owned } = await service
            .from('topics').select('topic_id')
            .eq('user_id', userId).eq('course_id', course_id).in('topic_id', topic_ids)
          validTopicIds = (owned ?? []).map((t: { topic_id: string }) => t.topic_id)
        }

        const { data: session, error: sessionError } = await service
          .from('session_log')
          .insert({
            user_id: userId,
            course_id,
            mode: 'mcp',
            name: `Claude session — ${course.name}`,
            topics_discussed: validTopicIds.length > 0 ? validTopicIds : null,
            duration_seconds: minutes ? minutes * 60 : null,
          })
          .select('session_id')
          .single()
        if (sessionError || !session) throw new McpToolError('log_failed')

        // Feed the same episodic memory the in-app distiller writes (M1), so the
        // in-app tutor's recap knows about MCP study too.
        await service.from('session_summaries').insert({
          user_id: userId,
          session_id: session.session_id,
          course_id,
          summary: summary.slice(0, 1200),
          topics_discussed: validTopicIds.length > 0 ? validTopicIds : null,
        })

        // Cheap, inference-free digest append (clamped — the next in-app distill
        // re-compresses everything properly).
        const { data: mem } = await service
          .from('course_memory').select('digest')
          .eq('user_id', userId).eq('course_id', course_id).maybeSingle()
        const appended = `${mem?.digest ?? ''}\n- (via the student's own Claude) ${summary.slice(0, 240)}`.trim()
        await service.from('course_memory').upsert({
          user_id: userId,
          course_id,
          digest: appended.slice(-DIGEST_CHAR_BUDGET),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,course_id' })

        const streak = await bumpStudyStreak(userId)
        return asText({
          ok: true,
          message: `Session logged to Cogni${streak ? ` — study streak: ${streak} day${streak === 1 ? '' : 's'}` : ''}.`,
        })
      }),
    )

    server.registerTool(
      'get_study_plan',
      {
        title: "Today's study plan",
        description: "The student's Cogni study plan for today (or a given date): review blocks, homework due, quizzes — with urgency reasons. Use it to answer 'what should I work on?'",
        inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; defaults to today in their timezone') },
      },
      guarded('get_study_plan', 'read', async ({ date }: { date?: string }, userId, tz) => {
        const service = createServiceClient()
        const planDate = date ?? await userToday(service, userId, tz)
        const { data: plan } = await service
          .from('study_plan').select('tasks')
          .eq('user_id', userId).eq('plan_date', planDate).maybeSingle()
        const tasks = ((plan?.tasks ?? []) as TaskItem[]).map(t => {
          if (t.type === 'insight') return { type: t.type, text: t.text }
          if (t.type === 'homework') return { type: t.type, course: t.course_name, title: t.title, due: t.due_date, overdue: t.overdue, assignment_id: t.assignment_id, why: t.reason }
          if (t.type === 'flashcard_review') return { type: t.type, course: t.course_name, cards_due: t.card_count, minutes: t.duration_minutes, why: t.reason }
          return { type: t.type, course: t.course_name, why: t.reason }
        })
        return asText({ date: planDate, tasks })
      }),
    )

    server.registerTool(
      'complete_assignment',
      {
        title: 'Mark an assignment complete',
        description: "Mark a homework assignment done in Cogni (assignment_id from get_course_overview or get_study_plan). Recomputes today's study plan so it reflects the change.",
        inputSchema: { assignment_id: z.string() },
      },
      guarded('complete_assignment', 'write', async ({ assignment_id }: { assignment_id: string }, userId) => {
        const service = createServiceClient()
        const { data: assignment } = await service
          .from('assignments').select('assignment_id, name')
          .eq('assignment_id', assignment_id).eq('user_id', userId).maybeSingle()
        if (!assignment) throw new McpToolError('assignment_not_found', 'assignment_id must come from get_course_overview or get_study_plan.')

        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        const { error } = await service
          .from('assignments').update({ completion_status: 'complete' })
          .eq('assignment_id', assignment_id).eq('user_id', userId)
        if (error) throw new McpToolError('update_failed')
        // Replan so Today reflects it immediately.
        await runScheduler(userId).catch(e => console.error('[mcp] post-completion replan failed', e))
        return asText({ ok: true, message: `"${assignment.name ?? 'Assignment'}" marked complete — today's plan recomputed.` })
      }),
    )

    server.registerTool(
      'record_quiz_result',
      {
        title: 'Record a quiz you ran',
        description: "After YOU quiz the student conversationally (you author the questions — costs them nothing), record the result so it shows in their Progress tab and moves mastery. Provide per-topic scores when you can.",
        inputSchema: {
          course_id: z.string().describe('A course_id from list_courses'),
          score_pct: z.number().min(0).max(100).describe('Overall score 0-100'),
          question_count: z.number().int().min(1).max(50),
          topic_scores: z.array(z.object({
            topic_id: z.string(),
            score: z.number().min(0).max(1),
          })).max(10).optional().describe('Per-topic fraction correct (topic_id from get_course_overview)'),
        },
      },
      guarded('record_quiz_result', 'write', async (
        { course_id, score_pct, question_count, topic_scores }: { course_id: string; score_pct: number; question_count: number; topic_scores?: { topic_id: string; score: number }[] },
        userId,
      ) => {
        const service = createServiceClient()
        const { data: course } = await service
          .from('courses').select('course_id')
          .eq('course_id', course_id).eq('user_id', userId).maybeSingle()
        if (!course) throw new McpToolError('course_not_found', 'course_id must come from list_courses.')

        const overBudget = await consumeMcpWrite(userId)
        if (overBudget) throw new McpToolError('daily_limit', overBudget)

        const { error } = await service.from('practice_test_results').insert({
          user_id: userId,
          course_id,
          test_type: 'practice_quiz',
          topic_filter: 'via your own Claude (MCP)',
          question_count,
          correct_count: Math.round((score_pct / 100) * question_count),
          score_pct: Math.round(score_pct * 100) / 100,
          missed_topics: [],
          mastery_updates: [],
        })
        if (error) throw new McpToolError('insert_failed')

        // Mastery evidence at the in-session quiz rate, ownership-validated.
        let updated = 0
        if (topic_scores && topic_scores.length > 0) {
          const ids = topic_scores.map(t => t.topic_id)
          const { data: owned } = await service
            .from('topics').select('topic_id')
            .eq('user_id', userId).eq('course_id', course_id).in('topic_id', ids)
          const ownedSet = new Set(((owned ?? []) as { topic_id: string }[]).map(t => t.topic_id))
          const evidences = topic_scores
            .filter(t => ownedSet.has(t.topic_id))
            .map(t => ({ topicId: t.topic_id, observed: t.score, learningRate: LEARNING_RATES.quiz_in_session }))
          if (evidences.length > 0) {
            const applied = await applyMasteryEvidence(userId, evidences).catch(() => [])
            updated = applied.length
          }
        }
        return asText({ ok: true, message: `Quiz recorded (${Math.round(score_pct)}%) — visible in Progress. Mastery updated for ${updated} topic${updated === 1 ? '' : 's'}.` })
      }),
    )

    server.registerTool(
      'research',
      {
        title: 'Deep research across course materials',
        description: "Multi-query search over the student's uploaded materials for synthesizing a study guide or deep answer. YOU write 2-5 angled sub-queries (definitions, examples, edge cases, professor's framing); the tool returns deduped excerpts with source filenames for citation.",
        inputSchema: {
          course_id: z.string().describe('A course_id from list_courses'),
          queries: z.array(z.string().min(3)).min(1).max(5).describe('2-5 sub-queries attacking the question from different angles'),
        },
      },
      guarded('research', 'read', async (
        { course_id, queries }: { course_id: string; queries: string[] },
        userId,
      ) => {
        const seen = new Set<string>()
        const collected: { material_id: string; chunk_index: number; content: string }[] = []
        for (const q of queries.slice(0, 5)) {
          const { chunks } = await retrieveChunksDetailed(q, course_id, userId, 4)
            .catch(() => ({ chunks: [] as { material_id: string; chunk_index: number; content: string }[] }))
          for (const c of chunks) {
            const key = `${c.material_id}:${c.chunk_index}`
            if (!seen.has(key)) {
              seen.add(key)
              collected.push(c)
            }
          }
        }
        if (collected.length === 0) {
          return asText('No matching material found across any sub-query. The topic may not be covered in the uploads — say so rather than inventing content.')
        }
        // Source filenames for citation.
        const service = createServiceClient()
        const materialIds = [...new Set(collected.map(c => c.material_id))]
        const { data: mats } = await service
          .from('materials').select('material_id, filename')
          .eq('user_id', userId).in('material_id', materialIds)
        const nameById = new Map(((mats ?? []) as { material_id: string; filename: string | null }[]).map(m => [m.material_id, m.filename ?? 'unknown file']))
        return asText({
          excerpts: collected.map(c => ({ source: nameById.get(c.material_id) ?? 'unknown file', content: c.content })),
          note: 'Cite sources by filename when synthesizing.',
        })
      }),
    )

    // ── PROMPT (M4): the tutoring persona ─────────────────────────────────────
    server.registerPrompt(
      'tutor',
      {
        title: 'Cogni tutor',
        description: "Tutor me using my Cogni course data. Loads Cogni's tutoring style + how to use the tools.",
      },
      async () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: TUTOR_GUIDE } }],
      }),
    )

    // X6: one-click study modes matching the in-app tutor's behaviors.
    server.registerPrompt(
      'exam_prep',
      {
        title: 'Exam prep session',
        description: 'Structured cram session for my next exam: readiness check, weakest topics first, verification questions.',
      },
      async () => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `${TUTOR_GUIDE}

THIS SESSION IS EXAM PREP. Structure it:
1. Call list_courses, then get_course_overview for the course I name — find the NEAREST upcoming exam and its grade weight.
2. Call get_weak_topics. Build a prioritized hit-list: high professor-weight × low mastery topics covered by that exam.
3. Work the list top-down: for each topic, search_materials first, explain what I'm missing, then pose ONE exam-style verification question. Grade my answer with grade_answer.
4. Track the clock with me — if the exam is days away, spread topics; if it's tomorrow, triage to the highest-weight gaps only.
5. End with: record the session via log_study_session, and tell me bluntly how ready I am and what to do tomorrow.`,
          },
        }],
      }),
    )

    server.registerPrompt(
      'review_session',
      {
        title: 'Flashcard review session',
        description: 'Run my due flashcards conversationally — quiz me card by card and record every rating.',
      },
      async () => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Run my Cogni flashcard review. Protocol:
1. Call get_due_cards (ask me which course first if I have several with cards due).
2. One card at a time: show the FRONT only. Wait for my answer.
3. Judge my answer against the back — be strict but fair. Show the back, tell me what I missed.
4. Call review_card with the honest rating (1=Again if I failed, 2=Hard if shaky, 3=Good, 4=Easy if instant) — every card, no exceptions, or the review doesn't count.
5. Keep a running score. At the end: call log_study_session with a summary, and tell me which topics need real study (not just cards).`,
          },
        }],
      }),
    )

    server.registerPrompt(
      'homework_help',
      {
        title: 'Homework help (coached)',
        description: "Walk me through a homework problem step by step — coach me, don't just solve it.",
      },
      async () => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Help me with a homework problem from one of my Cogni courses. Rules:
1. Call list_courses, then search_materials for the relevant concept once I share the problem — my professor's method wins over the generic one.
2. NEVER hand me the final answer. Restate the problem in one line, then walk the solution path ONE step at a time: ask what I'd try, let me do the work between steps.
3. Name the underlying course concept at each step so I learn the pattern.
4. When I'm wrong, point at the exact step and why — let me retry before you correct it.
5. After we solve it: summarize the method in 2-3 lines, call grade_answer for the main topic with an honest 0-1 score for how I did, and offer create_flashcards on anything I slipped on. End with log_study_session.`,
          },
        }],
      }),
    )
  },
  {},
  {
    basePath: '/api/mcp',
    maxDuration: 60,
    verboseLogs: false,
    // Stateless Streamable-HTTP only. On Vercel each request can hit a different
    // serverless instance, so the default (per-process session/SSE state) breaks
    // after `initialize` (works locally as one process, 500s on serverless). Disabling
    // SSE forces pure request/response with no cross-request state. If you ever need
    // resumable streams at scale, set REDIS_URL and the handler will use it instead.
    disableSse: true,
    redisUrl: process.env.REDIS_URL || process.env.KV_URL,
  },
)

const authHandler = withMcpAuth(handler, verifyMcpToken, { required: true })

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
