// Mega seed — a full-time student's whole semester (mid-November, ~week 11/15)
// across 6 varied courses, with realistic VOLUME so every surface is dense:
// ~70 topics, ~250 flashcards, ~40 assignments, ~15 exams, ~30 grade items,
// mastery-history trends, multi-course memory, usage history, a calendar full
// of deadlines. No AI — pure service-role inserts. Standalone (creates the auth
// user and writes seed-output.json so the Playwright login works).
import { writeFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env.SUPABASE_URL, KEY_ = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY_) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const db = createClient(URL_, KEY_, { auth: { autoRefreshToken: false, persistSession: false } })

const EMAIL = 'teststudent@example.com', PASSWORD = 'TestPassword123!', TZ = 'America/Los_Angeles'
const dKey = (off) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + off); return d.toISOString().slice(0, 10) }
const iso = (off) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + off); return d.toISOString() }
const pick = (arr, i) => arr[i % arr.length]
const insMany = async (table, rows) => { if (!rows.length) return; const { error } = await db.from(table).insert(rows); if (error) throw new Error(`${table}: ${error.message}`) }
const insOne = async (table, row) => { const { data, error } = await db.from(table).insert(row).select().single(); if (error) throw new Error(`${table}: ${error.message}`); return data }

// ── Course catalog: varied type, health, exam timing ────────────────────────
const CATALOG = [
  { code: 'CHEM 51B', name: 'Organic Chemistry II', type: 'quantitative', prof: 'Dr. Ramirez', health: 'critical', examIn: 3,
    topics: ['Stereochemistry', 'SN1/SN2 Reactions', 'Elimination Reactions', 'Alkene Addition', 'Aromaticity', 'Electrophilic Aromatic Substitution', 'Carbonyl Chemistry', 'Aldehydes & Ketones', 'Carboxylic Acids', 'Spectroscopy (NMR)', 'Reaction Mechanisms', 'Stereoselectivity'] },
  { code: 'MATH 2D', name: 'Multivariable Calculus', type: 'quantitative', prof: 'Dr. Chen', health: 'at_risk', examIn: 9,
    topics: ['Vectors & Geometry', 'Partial Derivatives', 'Gradient & Directional Deriv', 'Multiple Integrals', 'Polar/Cylindrical Coords', 'Line Integrals', 'Greens Theorem', 'Divergence & Curl', 'Lagrange Multipliers', 'Tangent Planes'] },
  { code: 'ECON 20A', name: 'Microeconomics', type: 'social_science', prof: 'Dr. Patel', health: 'at_risk', examIn: 16,
    topics: ['Supply & Demand', 'Elasticity', 'Consumer Theory', 'Production & Costs', 'Perfect Competition', 'Monopoly', 'Game Theory', 'Market Failure', 'Externalities'] },
  { code: 'PSY 9', name: 'Intro Psychology', type: 'social_science', prof: 'Dr. Okafor', health: 'healthy', examIn: 22,
    topics: ['Research Methods', 'Neuroscience Basics', 'Sensation & Perception', 'Learning & Conditioning', 'Memory', 'Cognition', 'Development', 'Social Psychology', 'Personality', 'Psychological Disorders'] },
  { code: 'ENG 28', name: 'Modern Literature', type: 'humanities', prof: 'Dr. Whitfield', health: 'healthy', examIn: null,
    topics: ['Modernism', 'Stream of Consciousness', 'Postcolonial Lit', 'Narrative Theory', 'Close Reading', 'The Unreliable Narrator', 'Symbolism & Allegory'] },
  { code: 'PHYS 7C', name: 'Physics for Engineers', type: 'quantitative', prof: 'Dr. Sato', health: 'healthy', examIn: 12,
    topics: ['Electric Fields', 'Gauss Law', 'Electric Potential', 'Capacitance', 'Current & Resistance', 'DC Circuits', 'Magnetic Fields', 'Faradays Law', 'Inductance', 'Maxwells Equations'] },
]

// health → (graded scores producing a target current grade)
const HEALTH = {
  critical: { exam: 58, hw: 64, baseMastery: 0.22, decay: true },
  at_risk:  { exam: 71, hw: 76, baseMastery: 0.4,  decay: true },
  healthy:  { exam: 90, hw: 93, baseMastery: 0.72, decay: false },
}

async function main() {
  // Auth user (idempotent)
  const { data: list } = await db.auth.admin.listUsers()
  const prior = list?.users?.find(u => u.email === EMAIL)
  if (prior) await db.auth.admin.deleteUser(prior.id)
  const { data: created, error: cErr } = await db.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true })
  if (cErr) throw new Error('createUser: ' + cErr.message)
  const userId = created.user.id

  await insOne('users', {
    user_id: userId, display_name: 'Jordan Lee', timezone: TZ, session_length_preference: 60,
    study_streak: 12, last_study_date: dKey(0), calendar_feed_token: crypto.randomUUID(),
  })

  const out = { email: EMAIL, password: PASSWORD, userId, timezone: TZ, courses: {} }
  let totalCards = 0, totalAssign = 0, totalExams = 0

  for (const [ci, spec] of CATALOG.entries()) {
    const h = HEALTH[spec.health]
    const prof = await insOne('professors', { user_id: userId, name: spec.prof, department: spec.type })
    const course = await insOne('courses', { user_id: userId, professor_id: prof.professor_id, name: spec.name, course_type: spec.type, active_status: 'active', icon: pick(['BookOpen','Atom','Flask','Calculator','ChartLine','Brain'], ci), icon_color: pick(['blue','violet','emerald','amber','rose','cyan'], ci) })

    // Topics + mastery (+ decay via old last_updated) + history trends
    const topicRows = spec.topics.map((name, ti) => ({ course_id: course.course_id, user_id: userId, name, syllabus_order: ti + 1, content_coverage: 0.3 + (ti % 5) * 0.12, professor_weight: 0.35 + ((ti * 7) % 6) * 0.11 }))
    const { data: topics } = await db.from('topics').insert(topicRows).select('topic_id, name')
    const masteryRows = [], historyRows = []
    topics.forEach((t, ti) => {
      const m = Math.max(0.05, Math.min(0.95, h.baseMastery + ((ti * 13) % 9 - 4) * 0.07))
      // half the topics were "crammed" weeks ago → decay shows
      const updated = h.decay && ti % 2 === 0 ? iso(-(40 + (ti % 30))) : iso(-(2 + ti % 5))
      masteryRows.push({ user_id: userId, topic_id: t.topic_id, mastery_score: Math.round(m * 100) / 100, confidence: 0.1 + (ti % 6) * 0.1, last_updated: updated })
      // 30-day trend: 6 points climbing toward m
      for (let d = 30; d >= 0; d -= 6) historyRows.push({ user_id: userId, topic_id: t.topic_id, mastery_score: Math.max(0, Math.round((m - d * 0.006) * 100) / 100), recorded_at: iso(-d) })
    })
    await insMany('topic_mastery', masteryRows)
    await insMany('mastery_history', historyRows)

    // Prerequisite chain (each topic builds on the previous)
    await insMany('topic_prerequisites', topics.slice(1, 5).map((t, ti) => ({ user_id: userId, course_id: course.course_id, topic_id: t.topic_id, prereq_topic_id: topics[ti].topic_id })))

    // Flashcards: 2–5 per topic, FSRS states spread for due/overdue/future volume
    const cardRows = []
    topics.forEach((t, ti) => {
      const n = 2 + (ti % 4)
      for (let k = 0; k < n; k++) {
        const phase = (ti + k) % 5
        const due = phase === 0 ? dKey(-(1 + k)) : phase === 1 ? dKey(0) : phase === 2 ? dKey(0) : phase === 3 ? dKey(1 + k) : dKey(4 + k)
        const reps = phase <= 2 ? 1 + (k % 4) : 0
        cardRows.push({ user_id: userId, course_id: course.course_id, topic_id: t.topic_id,
          front: `${t.name} — concept ${k + 1}`, back: `Key idea for ${t.name} (${k + 1}).`, hint: k === 0 ? 'recall the definition' : null,
          fsrs_state: reps > 0 ? 'review' : 'new', fsrs_next_review_date: due, fsrs_stability: 2 + (k * 3), fsrs_difficulty: 4 + (k % 4), fsrs_reps: reps, fsrs_lapses: phase === 0 ? 1 : 0, fsrs_last_review: reps > 0 ? iso(-(2 + k)) : null })
      }
    })
    await insMany('flashcards', cardRows); totalCards += cardRows.length

    // Grade scheme + items → target current grade
    await insMany('course_grade_schemes', [
      { user_id: userId, course_id: course.course_id, category: 'Exams', weight_pct: 50 },
      { user_id: userId, course_id: course.course_id, category: 'Homework', weight_pct: 30 },
      { user_id: userId, course_id: course.course_id, category: 'Participation', weight_pct: 20 },
    ])
    await insMany('grade_items', [
      { user_id: userId, course_id: course.course_id, category: 'Exams', name: 'Midterm 1', points_earned: h.exam, points_possible: 100, graded_at: iso(-35), source: 'manual' },
      { user_id: userId, course_id: course.course_id, category: 'Exams', name: 'Midterm 2', points_earned: h.exam + 3, points_possible: 100, graded_at: iso(-14), source: 'manual' },
      { user_id: userId, course_id: course.course_id, category: 'Homework', name: 'PSet 1', points_earned: Math.round(h.hw * 0.2), points_possible: 20, graded_at: iso(-30), source: 'manual' },
      { user_id: userId, course_id: course.course_id, category: 'Homework', name: 'PSet 2', points_earned: Math.round(h.hw * 0.2) - 1, points_possible: 20, graded_at: iso(-21), source: 'manual' },
      { user_id: userId, course_id: course.course_id, category: 'Homework', name: 'PSet 3', points_earned: Math.round(h.hw * 0.2), points_possible: 20, graded_at: iso(-7), source: 'manual' },
      { user_id: userId, course_id: course.course_id, category: 'Participation', name: 'Attendance', points_earned: 18, points_possible: 20, graded_at: iso(-3), source: 'manual' },
      // the final is recorded-but-ungraded → what-if has remaining weight
      { user_id: userId, course_id: course.course_id, category: 'Exams', name: 'Final Exam', points_earned: null, points_possible: 100, graded_at: iso(0), source: 'manual' },
    ])

    // Exams: a past graded midterm + (most courses) an upcoming exam with topics_covered
    const examRows = [{ course_id: course.course_id, user_id: userId, date: dKey(-14), grade_weight: 20, student_score: h.exam + 3, duration_minutes: 90, topics_covered: topics.slice(0, 4).map(t => t.topic_id) }]
    if (spec.examIn !== null) examRows.push({ course_id: course.course_id, user_id: userId, date: dKey(spec.examIn), grade_weight: 30, duration_minutes: 120, topics_covered: topics.slice(0, 6).map(t => t.topic_id) })
    await insMany('exams', examRows); totalExams += examRows.length

    // Assignments spread across the next 6 weeks (+ overdue) for a dense calendar
    const aRows = []
    const offsets = spec.health === 'critical' ? [-5, -2, 0, 2, 5, 9, 16, 23, 30] : spec.health === 'at_risk' ? [-2, 0, 3, 7, 12, 19, 28] : [0, 4, 8, 14, 21, 30]
    offsets.forEach((off, ai) => aRows.push({ course_id: course.course_id, user_id: userId, name: `${spec.code} ${pick(['Problem Set','Reading Response','Lab Report','Essay Draft','Quiz Prep','Project Milestone'], ai)} ${ai + 1}`, due_date: dKey(off) + 'T23:59:00Z', type: pick(['homework','project','quiz'], ai), completion_status: off < -1 && ai % 3 === 0 ? 'pending' : off < 0 ? (ai % 2 ? 'complete' : 'pending') : 'pending' }))
    await insMany('assignments', aRows); totalAssign += aRows.length

    // Tier-1 syllabus (so the course is "set up" — clears no-syllabus nudges)
    await insOne('materials', { user_id: userId, course_id: course.course_id, tier: 1, file_type: 'pdf', storage_path: `${userId}/${course.course_id}/syllabus.pdf`, filename: `${spec.code}-syllabus.pdf`, processing_status: 'processed' })

    // Material + embeddings (RAG keyword fallback) + storage
    const mat = await insOne('materials', { user_id: userId, course_id: course.course_id, tier: 2, file_type: 'txt', storage_path: `${userId}/${course.course_id}/notes.txt`, filename: `${spec.code}-notes.txt`, processing_status: 'processed' })
    await insMany('material_embeddings', [
      { user_id: userId, material_id: mat.material_id, chunk_index: 0, content: `${spec.name} core concepts: ${spec.topics.slice(0, 3).join(', ')}.` },
      { user_id: userId, material_id: mat.material_id, chunk_index: 1, content: `${spec.name} advanced: ${spec.topics.slice(3, 6).join(', ')}.` },
    ])
    await db.storage.from('materials').upload(mat.storage_path, new Blob([`${spec.name} notes`], { type: 'text/plain' }), { upsert: true }).catch(() => {})
    await db.storage.from('wiki').upload(`${userId}/professor_${prof.professor_id}.md`, new Blob([`# ${spec.prof}\nFavors ${pick(['conceptual','computational','application-based','proof-based'], ci)} questions. Exams are ${pick(['cumulative','non-cumulative'], ci)}.`], { type: 'text/markdown' }), { upsert: true }).catch(() => {})

    // Practice-test history (some on the at-risk/critical courses)
    if (spec.health !== 'healthy' || ci % 2 === 0) {
      await insMany('practice_test_results', [0, 1].map(k => ({ user_id: userId, course_id: course.course_id, test_type: k ? 'simulated_exam' : 'practice_quiz', topic_filter: k ? null : topics[0].name, question_count: k ? 20 : 8, correct_count: Math.round((h.exam / 100) * (k ? 20 : 8)), score_pct: h.exam + k * 2, missed_topics: topics.slice(0, 2).map(t => ({ topic: t.name, wrong_count: 1 })), mastery_updates: [], duration_seconds: k ? 3600 : null, created_at: iso(-(5 + k * 7)) })))
    }

    out.courses[spec.code] = { id: course.course_id, name: spec.name, health: spec.health, topicSample: topics[0].name }
  }

  // ── Cross-course memory (4 courses) ─────────────────────────────────────────
  const memCourses = CATALOG.slice(0, 4)
  for (const spec of memCourses) {
    const cid = out.courses[spec.code].id
    const { data: someTopics } = await db.from('topics').select('topic_id, name').eq('course_id', cid).limit(2)
    const sess = await insOne('session_log', { user_id: userId, course_id: cid, mode: 'teach', name: `${someTopics[0].name} review`, topics_discussed: someTopics.map(t => t.topic_id), duration_seconds: 1200 + Math.floor(Math.random() * 1800) })
    await insOne('session_summaries', { user_id: userId, session_id: sess.session_id, course_id: cid, summary: `Worked through ${someTopics[0].name}. Made progress but ${someTopics[1].name} is still shaky.`, confusions: [`${someTopics[1].name} edge cases`], understood: [someTopics[0].name], preferences: ['likes worked examples first'], topics_discussed: someTopics.map(t => t.topic_id), message_count: 8 + Math.floor(Math.random() * 12) })
    await insOne('course_memory', { user_id: userId, course_id: cid, digest: `Covered ${spec.topics.slice(0, 3).join(', ')}. Persistent confusion around ${someTopics[1].name}. Prefers worked examples before theory. Next: ${spec.topics[3]}.`, updated_at: iso(-(1 + CATALOG.indexOf(spec))) })
    await insMany('student_memory', [
      { user_id: userId, course_id: cid, topic_id: someTopics[1].topic_id, kind: 'misconception', content: `Confuses ${someTopics[1].name} with ${someTopics[0].name}`, source_session_id: sess.session_id, last_seen: iso(-2) },
      { user_id: userId, course_id: cid, kind: 'preference', content: 'Wants worked examples before the theory', source_session_id: sess.session_id, last_seen: iso(-2) },
      { user_id: userId, course_id: cid, kind: 'goal', content: `Targeting an ${spec.health === 'critical' ? 'B' : 'A'} — the final is 30% of the grade`, source_session_id: sess.session_id, last_seen: iso(-2) },
    ])
  }

  // ── Review history (review_logs) so the consistency signal is realistic ─────
  // A studying student has reviews in the last fortnight — without these the
  // semester-standing "idle fortnight" rule mis-flags well-prepared courses.
  for (const code of Object.keys(out.courses)) {
    const cid = out.courses[code].id
    const { data: someCards } = await db.from('flashcards').select('card_id, fsrs_stability, fsrs_difficulty, fsrs_state').eq('user_id', userId).eq('course_id', cid).eq('fsrs_state', 'review').limit(14)
    const logs = (someCards ?? []).map((card, k) => ({
      user_id: userId, card_id: card.card_id, client_review_id: crypto.randomUUID(),
      rating: 2 + (k % 3), prev_stability: card.fsrs_stability, prev_difficulty: card.fsrs_difficulty, prev_state: card.fsrs_state,
      new_stability: card.fsrs_stability + 2, new_difficulty: card.fsrs_difficulty, new_state: 'review',
      next_review_date: dKey(2 + (k % 5)), reviewed_at: iso(-(k % 13)),
    }))
    await insMany('review_logs', logs)
  }

  // ── Usage events across surfaces + models (last 30 days) ────────────────────
  const surfaces = [['tutor', 'claude-sonnet-4-6'], ['tutor', 'claude-opus-4-8'], ['quiz', 'claude-haiku-4-5-20251001'], ['flashcards', 'claude-haiku-4-5-20251001'], ['profiler', 'claude-sonnet-4-6'], ['memory', 'claude-haiku-4-5-20251001']]
  const usageRows = []
  for (let d = 0; d < 38; d++) { const [s, m] = pick(surfaces, d * 3 + (d % 5)); usageRows.push({ user_id: userId, surface: s, model: m, input_tokens: 2000 + (d * 137) % 6000, output_tokens: 400 + (d * 53) % 1200, cache_read_tokens: s === 'tutor' ? 6000 + (d * 211) % 7000 : 0, cache_write_tokens: s === 'tutor' && d % 4 === 0 ? 1300 : 0, created_at: iso(-(d % 30)) }) }
  await insMany('usage_events', usageRows)

  // MCP token
  const mcpPlain = 'cogni_mcp_' + crypto.randomBytes(24).toString('base64url')
  await db.from('mcp_tokens').upsert({ user_id: userId, token_hash: crypto.createHash('sha256').update(mcpPlain).digest('hex'), label: 'claude', expires_at: iso(180) }, { onConflict: 'user_id' })

  writeFileSync(new URL('./seed-output.json', import.meta.url), JSON.stringify(out, null, 2))
  console.log('MEGA SEED OK:', JSON.stringify({ courses: CATALOG.length, cards: totalCards, assignments: totalAssign, exams: totalExams, usage: usageRows.length }))
}

main().catch(e => { console.error('MEGA SEED FAILED:', e.message); process.exit(1) })
