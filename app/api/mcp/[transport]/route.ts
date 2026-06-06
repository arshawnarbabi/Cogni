import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyMcpToken, type McpAuthInfo } from '@/lib/mcp/auth'
import { mcpGuard, consumeMcpWrite, auditMcpCall } from '@/lib/mcp/guards'
import { retrieveChunksDetailed } from '@/lib/rag'
import { readWikiFile } from '@/lib/wiki'
import { newCardDefaults } from '@/lib/fsrs'
import { assignNewCardDueDates } from '@/lib/agents/flashcard'
import { dateKeyInTimeZone, isValidTimeZone } from '@/lib/time'

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
- Act: after explaining a discrete body of facts, offer to call \`create_flashcards\` so it lands in their spaced-repetition queue. Point them at \`get_due_cards\` when they want to review.
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
          service.from('topics').select('topic_id, name, professor_weight, topic_mastery(mastery_score)').eq('user_id', userId).eq('course_id', course_id),
          service.from('exams').select('date, grade_weight').eq('user_id', userId).eq('course_id', course_id).gte('date', today).order('date'),
          service.from('assignments').select('name, due_date, completion_status').eq('user_id', userId).eq('course_id', course_id).eq('completion_status', 'pending').order('due_date'),
        ])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const topicsOut = (topics.data ?? []).map((t: any) => {
          const ms = Array.isArray(t.topic_mastery) ? t.topic_mastery[0]?.mastery_score : null
          return { topic_id: t.topic_id, name: t.name, weight: Number(t.professor_weight ?? 0.5), mastery_pct: Math.round(Number(ms ?? 0) * 100) }
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
        let q = service.from('topics').select('topic_id, name, course_id, professor_weight, topic_mastery(mastery_score)').eq('user_id', userId)
        if (course_id) q = q.eq('course_id', course_id)
        const { data } = await q
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ranked = (data ?? []).map((t: any) => {
          const ms = Number((Array.isArray(t.topic_mastery) ? t.topic_mastery[0]?.mastery_score : 0) ?? 0)
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
