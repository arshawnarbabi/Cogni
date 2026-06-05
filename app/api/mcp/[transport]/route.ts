import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyMcpToken, type McpAuthInfo } from '@/lib/mcp/auth'
import { retrieveChunks } from '@/lib/rag'
import { readWikiFile } from '@/lib/wiki'
import { newCardDefaults } from '@/lib/fsrs'

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
      async (_args, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const service = createServiceClient()
        const { data } = await service
          .from('courses').select('course_id, name')
          .eq('user_id', userId).eq('active_status', 'active').order('created_at')
        return asText((data ?? []).map((c: { course_id: string; name: string }) => ({ course_id: c.course_id, name: c.name })))
      },
    )

    server.registerTool(
      'get_course_overview',
      {
        title: 'Course overview',
        description: 'Topics (with mastery %), upcoming exams, and pending assignments for a course. Use it to focus tutoring on what the student actually needs.',
        inputSchema: { course_id: z.string().describe('A course_id from list_courses') },
      },
      async ({ course_id }, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const service = createServiceClient()
        const today = new Date().toISOString().slice(0, 10)
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
      },
    )

    server.registerTool(
      'get_weak_topics',
      {
        title: 'Weak topics',
        description: 'The student\'s highest-leverage weak topics (high professor weight × low mastery). Steer practice here.',
        inputSchema: { course_id: z.string().optional().describe('Optional: limit to one course') },
      },
      async ({ course_id }, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
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
      },
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
      async ({ course_id, query }, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const chunks = await retrieveChunks(query, course_id, userId, 6).catch(() => [])
        if (chunks.length === 0) return asText('No matching course material found (the student may not have uploaded materials, or no OpenAI key is set for search).')
        return asText({ excerpts: chunks.map((c) => c.content) })
      },
    )

    server.registerTool(
      'get_due_cards',
      {
        title: 'Due flashcards',
        description: 'Flashcards the student has due for review today (optionally for one course). Useful for running a quick review.',
        inputSchema: { course_id: z.string().optional() },
      },
      async ({ course_id }, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const service = createServiceClient()
        const today = new Date().toISOString().slice(0, 10)
        let q = service.from('flashcards').select('card_id, front, back, hint, course_id, topic_id').eq('user_id', userId).lte('fsrs_next_review_date', today).limit(50)
        if (course_id) q = q.eq('course_id', course_id)
        const { data } = await q
        return asText({ due_count: (data ?? []).length, cards: data ?? [] })
      },
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
      async ({ course_id, topic_id, cards }, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const service = createServiceClient()
        // Verify the topic belongs to this user + course (don't trust client IDs).
        const { data: topic } = await service.from('topics').select('topic_id').eq('topic_id', topic_id).eq('user_id', userId).eq('course_id', course_id).maybeSingle()
        if (!topic) return asText({ error: 'topic_not_found', detail: 'topic_id must belong to the given course_id (call get_course_overview).' })
        const defaults = newCardDefaults()
        const { error } = await service.from('flashcards').insert(
          cards.map((c) => ({ user_id: userId, course_id, topic_id, front: c.front, back: c.back, hint: c.hint ?? null, ...defaults })),
        )
        if (error) return asText({ error: 'insert_failed' })
        return asText({ created: cards.length, message: `${cards.length} flashcards saved to Cogni and added to the review queue.` })
      },
    )

    server.registerTool(
      'get_learning_profile',
      {
        title: 'Learning profile',
        description: "The durable notes Cogni keeps about how this student learns (strengths, recurring misconceptions). Use it to calibrate your explanations.",
        inputSchema: {},
      },
      async (_args, extra) => {
        const userId = userIdFrom(extra)
        if (!userId) return asText({ error: 'unauthorized' })
        const profile = await readWikiFile(userId, 'learning_profile.md').catch(() => null)
        return asText(profile || 'No learning profile yet — it builds up as the student studies.')
      },
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
