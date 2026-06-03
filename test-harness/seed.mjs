// Seeds a realistic "mid-semester student" into the local Supabase via the
// service-role key. No AI, no UI. Writes the created IDs to seed-output.json
// for the Layer-2 engine tests to consume.
//
// Shapes chosen to exercise the audited fixes:
//  - TWO courses share ONE professor (+ a professor wiki file) -> course-delete
//    must NOT remove the shared professor wiki.
//  - Course A has materials + embeddings + a course_file + storage objects ->
//    delete must leave ZERO orphans.
//  - A high-professor-weight, low-mastery topic with ZERO due cards -> scheduler
//    must not emit a misleading "0 cards" review task.
//  - Due + future flashcards, an upcoming exam, due + overdue assignments.
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !SUPA_KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const db = createClient(SUPA_URL, SUPA_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const TEST_EMAIL = 'teststudent@example.com'
const TEST_PASSWORD = 'TestPassword123!'
const TZ = 'America/Los_Angeles'

const dayKey = (offset) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const ins = async (table, row) => {
  const { data, error } = await db.from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

async function main() {
  // Clean any prior test user (idempotent re-seed)
  const { data: existing } = await db.auth.admin.listUsers()
  const prior = existing?.users?.find(u => u.email === TEST_EMAIL)
  if (prior) { await db.auth.admin.deleteUser(prior.id) }

  // 1. Auth user (confirmed, so email/password sign-in works immediately)
  const { data: created, error: cErr } = await db.auth.admin.createUser({
    email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true,
  })
  if (cErr) throw new Error('createUser: ' + cErr.message)
  const userId = created.user.id

  // 2. Onboarded profile (so the UI skips onboarding) — non-UTC timezone on purpose
  await ins('users', { user_id: userId, display_name: 'Test Student', timezone: TZ, session_length_preference: 45 })

  // 3. One professor, shared by two courses
  const prof = await ins('professors', { user_id: userId, name: 'Dr. Kandel', department: 'Physics' })

  const courseA = await ins('courses', { user_id: userId, professor_id: prof.professor_id, name: 'Physics 1', course_type: 'quantitative', active_status: 'active' })
  const courseB = await ins('courses', { user_id: userId, professor_id: prof.professor_id, name: 'Physics 2', course_type: 'quantitative', active_status: 'active' })

  // 4. Topics in course A: one with cards, one HIGH-weight/LOW-mastery with ZERO cards
  const kinematics = await ins('topics', { course_id: courseA.course_id, user_id: userId, name: 'Kinematics', syllabus_order: 1, content_coverage: 0.8, professor_weight: 0.6 })
  const dynamics = await ins('topics', { course_id: courseA.course_id, user_id: userId, name: 'Dynamics', syllabus_order: 2, content_coverage: 0.2, professor_weight: 0.9 })
  await ins('topic_mastery', { user_id: userId, topic_id: kinematics.topic_id, mastery_score: 0.5 })
  await ins('topic_mastery', { user_id: userId, topic_id: dynamics.topic_id, mastery_score: 0.15 }) // low + high weight + 0 cards

  // 5. Flashcards in Kinematics: 3 due (today/past), 2 future
  const cards = []
  for (const [i, due] of [dayKey(-1), dayKey(0), dayKey(0), dayKey(3), dayKey(5)].entries()) {
    const c = await ins('flashcards', {
      user_id: userId, course_id: courseA.course_id, topic_id: kinematics.topic_id,
      front: `Kinematics Q${i + 1}`, back: `Answer ${i + 1}`,
      fsrs_state: i < 3 ? 'review' : 'new', fsrs_next_review_date: due,
      fsrs_stability: 5, fsrs_difficulty: 5, fsrs_reps: i < 3 ? 2 : 0,
    })
    cards.push(c.card_id)
  }

  // 6. Upcoming exam + due/overdue assignments
  const exam = await ins('exams', { course_id: courseA.course_id, user_id: userId, date: dayKey(5), grade_weight: 30, duration_minutes: 90 })
  await ins('assignments', { course_id: courseA.course_id, user_id: userId, name: 'Pset 1 (due today)', due_date: dayKey(0) + 'T00:00:00Z', type: 'homework', completion_status: 'pending' })
  await ins('assignments', { course_id: courseA.course_id, user_id: userId, name: 'Pset 0 (overdue)', due_date: dayKey(-2) + 'T00:00:00Z', type: 'homework', completion_status: 'pending' })

  // 7. Material + embeddings (for RAG keyword fallback) + a course_file
  const material = await ins('materials', { user_id: userId, course_id: courseA.course_id, tier: 2, file_type: 'txt', storage_path: `${userId}/kinematics-notes.txt`, filename: 'kinematics-notes.txt', processing_status: 'processed' })
  await ins('material_embeddings', { user_id: userId, material_id: material.material_id, chunk_index: 0, content: 'Newton second law states force equals mass times acceleration. Kinematics describes motion with velocity and acceleration.' })
  await ins('material_embeddings', { user_id: userId, material_id: material.material_id, chunk_index: 1, content: 'Projectile motion combines horizontal constant velocity with vertical acceleration due to gravity.' })
  const courseFile = await ins('course_files', { user_id: userId, course_id: courseA.course_id, name: 'syllabus.txt', mime_type: 'text/plain', size_bytes: 17, storage_path: `${userId}/${courseA.course_id}/syllabus.txt` })

  // 8. Storage objects: professor wiki (shared), material file, course file
  const up = async (bucket, path, text) => {
    const { error } = await db.storage.from(bucket).upload(path, new Blob([text], { type: 'text/plain' }), { upsert: true })
    if (error && !/exists/i.test(error.message)) throw new Error(`storage ${bucket}/${path}: ${error.message}`)
  }
  await up('wiki', `${userId}/professor_${prof.professor_id}.md`, '# Dr. Kandel\nFavors conceptual questions.')
  await up('wiki', `${userId}/learning_profile.md`, '# Learning Profile\nStrong in algebra.')
  await up('materials', material.storage_path, 'Newton second law F=ma. Kinematics notes.')
  await up('course-files', courseFile.storage_path, 'Physics 1 syllabus')

  const out = {
    email: TEST_EMAIL, password: TEST_PASSWORD, userId, timezone: TZ,
    professorId: prof.professor_id,
    courseA: courseA.course_id, courseB: courseB.course_id,
    topics: { kinematics: kinematics.topic_id, dynamics: dynamics.topic_id },
    cards, materialId: material.material_id, examId: exam.exam_id,
    profWikiPath: `${userId}/professor_${prof.professor_id}.md`,
  }
  writeFileSync(new URL('./seed-output.json', import.meta.url), JSON.stringify(out, null, 2))
  console.log('SEED OK:', JSON.stringify({ userId, courseA: out.courseA, courseB: out.courseB, cards: cards.length }, null, 0))
}

main().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1) })
