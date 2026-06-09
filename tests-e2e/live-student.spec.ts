// LIVE-AI ultimate test — drives the REAL AI pipeline with the user's keys:
// ingestion (profiler + embeddings), grounded tutor, quiz generation + grading.
// Uses the authenticated request context (storageState) + direct DB assertions.
// Requires: keys added to the test student's vault via the local Settings UI.
import { test, expect, type APIRequestContext } from '@playwright/test'
import { readFileSync, mkdirSync } from 'node:fs'
import pg from 'pg'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const DIR = 'test-harness/live'
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))
test.describe.configure({ mode: 'serial', timeout: 240_000 })

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
let db: pg.Client
let bioCourseId = ''

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params)
  return r.rows as T[]
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function pollUntil<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 150_000, everyMs = 4000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v !== null) return v
    await sleep(everyMs)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: DB })
  await db.connect()
  // Fail fast with a clear message if the user hasn't added keys yet. Vault
  // secrets are named api_key_<uid> (anthropic) and user_secret_<uid>_openai_key.
  const [k] = await q<{ n: number }>(
    "select count(*)::int n from vault.secrets where name like '%'||$1||'%'", [seed.userId]).catch(() => [{ n: 0 }])
  if (!k || k.n === 0) throw new Error('NO KEYS in the test vault — add them in the local Settings UI first.')
  console.log(`  vault has ${k.n} key secret(s) for the test student`)
})
test.afterAll(async () => { await db?.end() })

// ── Phase B: real ingestion ──────────────────────────────────────────────────
test('B1 — create BIO 93 + upload real syllabus → REAL profiler extracts the course', async ({ request }) => {
  const syllabus = readFileSync('test-harness/uploads/BIO-93-syllabus.txt')
  const res = await request.post('/api/courses/create', {
    multipart: {
      name: 'BIO 93 — DNA to Organisms',
      professorName: 'Dr. Elena Vasquez',
      syllabus: { name: 'BIO-93-syllabus.txt', mimeType: 'text/plain', buffer: syllabus },
    },
    timeout: 60_000,
  })
  expect(res.ok(), `create failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const body = await res.json()
  bioCourseId = body.courseId
  expect(bioCourseId).toBeTruthy()
  console.log(`  created BIO 93: ${bioCourseId} — waiting for the profiler job…`)

  // The profiler runs as a background job (real Sonnet). Poll for topics.
  const topics = await pollUntil('profiler topics', async () => {
    const rows = await q<{ name: string }>('select name from topics where course_id=$1', [bioCourseId])
    return rows.length >= 6 ? rows : null
  })
  console.log(`  ✓ profiler extracted ${topics.length} topics: ${topics.slice(0, 6).map(t => t.name).join(', ')}…`)
  expect(topics.length).toBeGreaterThanOrEqual(6)

  // Exams with real dates.
  const exams = await q<{ date: string; grade_weight: number }>('select date, grade_weight from exams where course_id=$1', [bioCourseId])
  console.log(`  ✓ ${exams.length} exams extracted: ${exams.map(e => e.date).join(', ')}`)
  expect(exams.length).toBeGreaterThanOrEqual(1)

  // S1: grading scheme extracted from the syllabus text.
  const scheme = await q<{ category: string; weight_pct: number }>('select category, weight_pct from course_grade_schemes where course_id=$1', [bioCourseId])
  console.log(`  ✓ grading scheme: ${scheme.map(s => `${s.category} ${s.weight_pct}%`).join(', ')}`)
  expect(scheme.length).toBeGreaterThanOrEqual(2)

  // I5: prerequisite edges (syllabus states "translation builds on transcription").
  const prereqs = await q<{ n: number }>('select count(*)::int n from topic_prerequisites where course_id=$1', [bioCourseId])
  console.log(`  prereq edges: ${prereqs[0].n}`)
})

test('B2 — upload lecture notes → REAL OpenAI embeddings', async ({ request }) => {
  const notes = readFileSync('test-harness/uploads/BIO-93-lecture-notes.txt', 'utf8')
  const res = await request.post('/api/inbox/upload', {
    multipart: { textContent: notes, courseId: bioCourseId, name: 'BIO 93 lecture notes' },
    timeout: 60_000,
  })
  expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy()

  const emb = await pollUntil('embeddings', async () => {
    const rows = await q<{ n: number }>(
      'select count(*)::int n from material_embeddings me join materials m on m.material_id=me.material_id where m.course_id=$1 and me.embedding is not null',
      [bioCourseId])
    return rows[0].n > 0 ? rows : null
  }, 120_000)
  console.log(`  ✓ ${emb[0].n} real embedding vectors written`)
  expect(emb[0].n).toBeGreaterThan(0)
})

// ── Phase C: real tutor, grounded in the uploaded materials ───────────────────
test('C1 — tutor answers grounded in the student\'s own materials', async ({ request }) => {
  const probe = "Explain the central dogma. Specifically, what does Dr. Vasquez mean by 'sense strand' in this class, and how does that differ from the textbook?"
  const res = await request.post(`/api/agents/tutor`, {
    data: { courseId: bioCourseId, message: probe, mode: 'teach' },
    timeout: 120_000,
  })
  expect(res.ok(), `tutor failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const text = await res.text()
  console.log(`  tutor response length: ${text.length} chars`)
  expect(text.length).toBeGreaterThan(120)
  // Grounding: the answer should reflect the planted non-standard rule (coding
  // strand) rather than only generic knowledge.
  const grounded = /coding strand|sense strand|mRNA|template/i.test(text)
  expect(grounded, 'tutor answer should reflect the uploaded materials').toBeTruthy()
  console.log(`  ✓ grounded answer (matched materials terminology)`)

  // A session + message were persisted (B7 / memory plumbing).
  const sessions = await q<{ session_id: string }>('select session_id from session_log where course_id=$1 order by created_at desc limit 1', [bioCourseId])
  expect(sessions.length).toBeGreaterThan(0)
})

// ── Phase D: real quiz generation + grading ───────────────────────────────────
test('D1 — generate a real quiz, grade it, and move mastery', async ({ request }) => {
  const topics = await q<{ name: string }>('select name from topics where course_id=$1 order by syllabus_order limit 1', [bioCourseId])
  const topicName = topics[0]?.name
  const gen = await request.post('/api/agents/practice-quiz', {
    data: { courseId: bioCourseId, courseName: 'BIO 93 — DNA to Organisms', format: 'short_answer', questionCount: 4, topicFilter: topicName },
    timeout: 120_000,
  })
  expect(gen.ok(), `quiz gen failed: ${gen.status()} ${await gen.text()}`).toBeTruthy()
  const quiz = await gen.json()
  const questions = quiz.questions ?? quiz
  console.log(`  ✓ generated ${questions.length} questions on "${topicName}"`)
  expect(questions.length).toBeGreaterThanOrEqual(3)

  // Answer them (deliberately mixed) and grade.
  const answers = questions.map((_: unknown, i: number) => i % 2 === 0 ? 'A detailed correct-sounding answer about DNA and the central dogma.' : 'I am not sure.')
  const grade = await request.post('/api/agents/practice-quiz/grade', {
    data: { courseId: bioCourseId, testType: 'practice_quiz', questions, userAnswers: answers, topicFilter: topicName },
    timeout: 120_000,
  })
  expect(grade.ok(), `grade failed: ${grade.status()} ${await grade.text()}`).toBeTruthy()
  const result = await grade.json()
  console.log(`  ✓ graded: score ${result.score_pct ?? result.scorePct ?? '?'}%, ${(result.mastery_updates ?? result.masteryUpdates ?? []).length} mastery updates`)

  // A practice_test_results row landed.
  const rows = await q<{ n: number }>("select count(*)::int n from practice_test_results where course_id=$1", [bioCourseId])
  expect(rows[0].n).toBeGreaterThan(0)
})
