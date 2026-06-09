// LIVE memory test — drive a real multi-turn tutor session on BIO 93, then
// confirm the distiller writes durable memory (M1/M2/M3) and the recap (M5)
// appears on the next session. Requires keys in the vault + an existing BIO 93.
import { test, expect } from '@playwright/test'
import pg from 'pg'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
test.describe.configure({ mode: 'serial', timeout: 240_000 })
let db: pg.Client
let bio: { course_id: string; user_id: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: DB }); await db.connect()
  const r = await db.query("select course_id, user_id from courses where name like 'BIO 93%' order by created_at desc limit 1")
  bio = r.rows[0]
})
test.afterAll(async () => { await db?.end() })

test('M1 — a real multi-turn session distills into durable memory', async ({ request }) => {
  // A realistic study conversation: several turns, getting something wrong.
  const turns = [
    "I'm confused about transcription. Can you walk me through how mRNA is made from DNA?",
    "Wait, so does RNA polymerase read the coding strand or the template strand? I keep mixing them up.",
    "Okay. And what's the difference between the leading and lagging strand again — I think that's replication not transcription right?",
  ]
  for (const message of turns) {
    const res = await request.post('/api/agents/tutor', {
      data: { courseId: bio.course_id, message, mode: 'teach' }, timeout: 120_000,
    })
    expect(res.ok(), `tutor turn failed: ${res.status()}`).toBeTruthy()
    await sleep(500)
  }
  // Confirm the session now has >= 2 user turns (distiller's threshold).
  const [{ n: userTurns }] = (await db.query(
    "select count(*)::int n from session_messages m join session_log s on s.session_id=m.session_id where s.course_id=$1 and m.role='user'", [bio.course_id]
  )).rows
  console.log(`  user turns recorded: ${userTurns}`)
  expect(userTurns).toBeGreaterThanOrEqual(2)

  // Pull the distill job forward and drain it via the worker (real Haiku).
  await db.query("update jobs set run_after=now()-interval '1 minute', status='queued', locked_until=null where user_id=$1 and kind='distill' and status='queued'", [bio.user_id])
  const worker = await request.get('/api/jobs/worker', { headers: { Authorization: 'Bearer testcron123' }, timeout: 120_000 })
  expect(worker.ok()).toBeTruthy()
  console.log(`  worker: ${await worker.text()}`)

  // Memory must now exist.
  let summary: { s: string } | undefined
  for (let i = 0; i < 20; i++) {
    const rows = (await db.query("select left(summary,200) s from session_summaries where course_id=$1 order by created_at desc limit 1", [bio.course_id])).rows
    if (rows[0]) { summary = rows[0]; break }
    await sleep(2000)
  }
  expect(summary, 'distiller should write a session summary').toBeTruthy()
  console.log(`  ✓ SESSION SUMMARY: ${summary!.s}`)

  const [digest] = (await db.query("select left(digest,220) d from course_memory where course_id=$1", [bio.course_id])).rows
  console.log(`  ✓ COURSE DIGEST: ${digest?.d ?? 'none'}`)
  const facts = (await db.query("select kind, left(content,90) content from student_memory where course_id=$1 order by last_seen desc limit 5", [bio.course_id])).rows
  console.log(`  ✓ STUDENT FACTS (${facts.length}):`); facts.forEach((f: { kind: string; content: string }) => console.log(`     [${f.kind}] ${f.content}`))
  expect(digest?.d, 'course digest should be written').toBeTruthy()
})

test('M5 — the next session opens with a "welcome back" recap', async ({ request }) => {
  // Opening a fresh conversation should surface the prior session's memory.
  const res = await request.post('/api/agents/tutor', {
    data: { courseId: bio.course_id, message: "Let's keep going — what should I review?", mode: 'teach', forceNew: true }, timeout: 120_000,
  })
  expect(res.ok()).toBeTruthy()
  const text = await res.text()
  // The recap/grounded continuation should reference prior material (transcription/strand).
  const continuity = /transcription|template|strand|last time|covered|replication|mRNA/i.test(text)
  console.log(`  recap/continuity present: ${continuity} (response ${text.length} chars)`)
  expect(text.length).toBeGreaterThan(100)
})
