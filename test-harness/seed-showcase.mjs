// Showcase seed — runs AFTER seed.mjs (reuses its auth user + courses) and
// fills the NEW features with realistic data so every surface shows real
// content when driving the dashboard:
//   - grade schemes + grade items → an AT-RISK course A and a HEALTHY course B
//   - decayed mastery (old last_updated) → I1 decay visible in weak areas
//   - session_log + session_summaries + course_memory + student_memory → Memory center
//   - usage_events across surfaces → Usage & cost panel
//   - calendar_feed_token + an mcp token + a topic prerequisite
// No AI, no UI — pure service-role inserts.
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !SUPA_KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const db = createClient(SUPA_URL, SUPA_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const seed = JSON.parse(readFileSync(new URL('./seed-output.json', import.meta.url), 'utf8'))
const { userId, courseA, courseB, topics } = seed

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
const ins = async (table, row) => {
  const { error } = await db.from(table).insert(row)
  if (error) throw new Error(`${table}: ${error.message}`)
}

async function main() {
  // ── Grade scheme + items ───────────────────────────────────────────────────
  // Course A "Physics 1": AT RISK — Exams 50 / Homework 30 / Participation 20,
  // graded so far ≈ 71% with the big final still ahead.
  await db.from('course_grade_schemes').delete().eq('user_id', userId).in('course_id', [courseA, courseB])
  await db.from('grade_items').delete().eq('user_id', userId).in('course_id', [courseA, courseB])

  await ins('course_grade_schemes', [
    { user_id: userId, course_id: courseA, category: 'Exams', weight_pct: 50 },
    { user_id: userId, course_id: courseA, category: 'Homework', weight_pct: 30 },
    { user_id: userId, course_id: courseA, category: 'Participation', weight_pct: 20 },
  ])
  await ins('grade_items', [
    { user_id: userId, course_id: courseA, category: 'Exams', name: 'Midterm 1', points_earned: 68, points_possible: 100, graded_at: daysAgo(30), source: 'manual' },
    { user_id: userId, course_id: courseA, category: 'Homework', name: 'PSet 1', points_earned: 16, points_possible: 20, graded_at: daysAgo(25), source: 'manual' },
    { user_id: userId, course_id: courseA, category: 'Homework', name: 'PSet 2', points_earned: 14, points_possible: 20, graded_at: daysAgo(18), source: 'manual' },
    // The final is recorded-but-ungraded so the what-if has remaining weight.
    { user_id: userId, course_id: courseA, category: 'Exams', name: 'Final (upcoming)', points_earned: null, points_possible: 100, graded_at: daysAgo(0), source: 'manual' },
  ])

  // Course B "Physics 2": HEALTHY — cruising at ~92%.
  await ins('course_grade_schemes', [
    { user_id: userId, course_id: courseB, category: 'Exams', weight_pct: 60 },
    { user_id: userId, course_id: courseB, category: 'Labs', weight_pct: 40 },
  ])
  await ins('grade_items', [
    { user_id: userId, course_id: courseB, category: 'Exams', name: 'Midterm', points_earned: 91, points_possible: 100, graded_at: daysAgo(20), source: 'manual' },
    { user_id: userId, course_id: courseB, category: 'Labs', name: 'Lab 1', points_earned: 19, points_possible: 20, graded_at: daysAgo(15), source: 'manual' },
    { user_id: userId, course_id: courseB, category: 'Labs', name: 'Lab 2', points_earned: 18, points_possible: 20, graded_at: daysAgo(8), source: 'manual' },
  ])

  // ── Decayed mastery: make Kinematics an old "crammed" high score so I1 decay
  // pulls its effective value down and it shows in weak areas. ─────────────────
  await db.from('topic_mastery').update({ mastery_score: 0.85, last_updated: daysAgo(70), confidence: 0.4 })
    .eq('user_id', userId).eq('topic_id', topics.kinematics)

  // ── Prerequisite edge (I5): Dynamics builds on Kinematics ───────────────────
  await db.from('topic_prerequisites').delete().eq('user_id', userId).eq('course_id', courseA)
  await ins('topic_prerequisites', { user_id: userId, course_id: courseA, topic_id: topics.dynamics, prereq_topic_id: topics.kinematics })

  // ── Memory: a prior session distilled into episodic + rolling + structured ──
  await db.from('session_summaries').delete().eq('user_id', userId)
  await db.from('course_memory').delete().eq('user_id', userId)
  await db.from('student_memory').delete().eq('user_id', userId)
  const { data: sess } = await db.from('session_log').insert({
    user_id: userId, course_id: courseA, mode: 'teach',
    name: 'Kinematics — projectile motion', topics_discussed: [topics.kinematics], duration_seconds: 1500,
  }).select('session_id').single()
  await ins('session_summaries', {
    user_id: userId, session_id: sess.session_id, course_id: courseA,
    summary: 'Worked through projectile motion. Solid on horizontal/vertical decomposition; kept dropping the sign on downward acceleration.',
    confusions: ['sign of g on the way up vs down'], understood: ['velocity vector decomposition'],
    preferences: ['likes worked examples before theory'], topics_discussed: [topics.kinematics], message_count: 14,
  })
  await ins('course_memory', {
    user_id: userId, course_id: courseA,
    digest: 'Covered: kinematics (velocity/acceleration, projectile motion). Persistent confusion: sign of gravitational acceleration. Prefers worked examples first. Next: Newton’s laws / dynamics.',
    updated_at: daysAgo(2),
  })
  await ins('student_memory', [
    { user_id: userId, course_id: courseA, topic_id: topics.kinematics, kind: 'misconception', content: 'Applies +g instead of -g for upward motion', source_session_id: sess.session_id, last_seen: daysAgo(2) },
    { user_id: userId, course_id: courseA, kind: 'preference', content: 'Wants worked examples before the theory', source_session_id: sess.session_id, last_seen: daysAgo(2) },
    { user_id: userId, course_id: courseA, kind: 'goal', content: 'Targeting an A-; the final is 25% of the grade', source_session_id: sess.session_id, last_seen: daysAgo(2) },
  ])

  // ── Usage & cost events across surfaces (last 30 days) ──────────────────────
  await db.from('usage_events').delete().eq('user_id', userId)
  const usage = [
    ['tutor', 'claude-sonnet-4-6', 4200, 800, 9000, 1200],
    ['tutor', 'claude-sonnet-4-6', 3800, 650, 8800, 0],
    ['tutor', 'claude-opus-4-8', 5200, 1400, 11000, 1600],
    ['quiz', 'claude-haiku-4-5-20251001', 1800, 900, 0, 0],
    ['flashcards', 'claude-haiku-4-5-20251001', 2400, 1100, 0, 0],
    ['profiler', 'claude-sonnet-4-6', 9000, 700, 0, 0],
    ['memory', 'claude-haiku-4-5-20251001', 3000, 300, 0, 0],
  ]
  await ins('usage_events', usage.map(([surface, model, i, o, cr, cw], k) => ({
    user_id: userId, surface, model, input_tokens: i, output_tokens: o,
    cache_read_tokens: cr, cache_write_tokens: cw, created_at: daysAgo(k + 1),
  })))

  // ── Calendar feed token + an MCP token so those panels show "connected" ─────
  const feedToken = crypto.randomUUID()
  await db.from('users').update({ calendar_feed_token: feedToken }).eq('user_id', userId)
  const mcpPlain = 'cogni_mcp_' + crypto.randomBytes(24).toString('base64url')
  await db.from('mcp_tokens').upsert({
    user_id: userId, token_hash: crypto.createHash('sha256').update(mcpPlain).digest('hex'),
    label: 'claude', expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(),
  }, { onConflict: 'user_id' })

  console.log('SHOWCASE SEED OK:', JSON.stringify({
    courseA_grade: '~71% (at risk)', courseB_grade: '~92% (healthy)',
    memory: '1 session + digest + 3 facts', usage_events: usage.length,
    feedToken: feedToken.slice(0, 8) + '…',
  }))
}

main().catch(e => { console.error('SHOWCASE SEED FAILED:', e.message); process.exit(1) })
