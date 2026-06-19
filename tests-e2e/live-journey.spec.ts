// LIVE end-to-end AI journey — runs the real BYOK pipeline a student hits:
// tutor chat (grounded), vision grade-extraction, flashcard generation, and
// proves recordUsage tracks the real cost. Requires the test user's Anthropic
// key in the local vault. Keep it lean — these are real billed calls.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const ids = JSON.parse(readFileSync('/tmp/live-ids.json', 'utf8'))
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
test.describe.configure({ mode: 'serial', timeout: 180_000 })

function parseEvents(body: string): { t: string; [k: string]: unknown }[] {
  const out: { t: string }[] = []
  for (const line of body.split('\n')) {
    const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && o.t) out.push(o) } catch { /* non-JSON keepalive */ }
  }
  return out
}

test('Tutor — a real grounded streaming answer comes back (proves tutor + stream pipeline)', async ({ request }) => {
  const res = await request.post('/api/agents/tutor', {
    data: { courseId: ids.courseId, courseName: ids.courseName, message: `In ${ids.topicName}, what does Gauss's law relate? Answer in 2 sentences.`, mode: 'answer' },
    timeout: 150_000,
  })
  expect(res.ok(), `tutor HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`).toBeTruthy()
  const events = parseEvents(await res.text())
  const text = events.filter(e => e.t === 'text').map(e => (e as { c?: string }).c ?? '').join('')
  console.log(`  tutor streamed ${events.length} events, ${text.length} chars`)
  console.log(`  answer: ${text.slice(0, 220).replace(/\n/g, ' ')}…`)
  expect(text.length, 'a non-empty assistant answer streamed back').toBeGreaterThan(40)
  expect(text.toLowerCase()).toMatch(/electric|flux|charge|field|gauss/) // grounded in the topic
})

test('Vision — uploading a graded exam extracts the score into a PENDING grade (Feature 1, live Haiku vision)', async ({ request }) => {
  const db = new Client({ connectionString: DB }); await db.connect()
  await db.query("delete from grade_items where user_id=$1 and source='upload'", [seed.userId])
  await db.query("delete from materials where user_id=$1 and filename like 'physics-midterm-graded%'", [seed.userId])

  const img = readFileSync('test-harness/uploads/physics-midterm-graded.png')
  const res = await request.post('/api/inbox/upload', {
    multipart: { file: { name: 'physics-midterm-graded.png', mimeType: 'image/png', buffer: img } },
    timeout: 150_000,
  })
  expect(res.ok(), `upload HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`).toBeTruthy()

  let row: { name: string; pe: number; pp: number; course: string } | undefined
  for (let i = 0; i < 24; i++) {
    const r = (await db.query(
      `select g.name, g.points_earned::float pe, g.points_possible::float pp, c.name course
       from grade_items g join courses c on c.course_id=g.course_id
       where g.user_id=$1 and g.source='upload' and g.confirmed=false order by g.graded_at desc limit 1`, [seed.userId])).rows[0]
    if (r) { row = r; break }
    await new Promise(res => setTimeout(res, 2500))
  }
  await db.end()
  expect(row, 'a pending grade should have been extracted from the image').toBeTruthy()
  console.log(`  ✓ vision extracted: "${row!.name}" ${row!.pe}/${row!.pp} → ${row!.course} (pending)`)
  expect(row!.pp).toBe(100)
  expect(row!.pe).toBeGreaterThanOrEqual(80)
  expect(row!.pe).toBeLessThanOrEqual(88)
})

test('Flashcards — the AI generates real cards for a topic (live Haiku)', async ({ request }) => {
  const db = new Client({ connectionString: DB }); await db.connect()
  const before = (await db.query('select count(*)::int n from flashcards where user_id=$1 and topic_id=$2', [seed.userId, ids.topicId])).rows[0].n
  const res = await request.post('/api/flashcards/generate', { data: { courseId: ids.courseId, topicId: ids.topicId }, timeout: 150_000 })
  expect(res.ok(), `flashcards HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`).toBeTruthy()
  const body = await res.json()
  const after = (await db.query('select count(*)::int n from flashcards where user_id=$1 and topic_id=$2', [seed.userId, ids.topicId])).rows[0].n
  await db.end()
  console.log(`  generated ${body.generated ?? after - before} cards (${before} → ${after})`)
  expect(after, 'new cards were generated').toBeGreaterThan(before)
})

test('recordUsage — the real AI calls above were tracked for the cost panel (#30)', async () => {
  const db = new Client({ connectionString: DB }); await db.connect()
  const now = (await db.query('select count(*)::int n from usage_events where user_id=$1', [seed.userId])).rows[0].n
  const recent = (await db.query(
    "select surface, model, count(*)::int n from usage_events where user_id=$1 group by 1,2 order by 3 desc limit 8", [seed.userId])).rows
  await db.end()
  console.log(`  usage_events: ${ids.usageBaseline} → ${now} (+${now - ids.usageBaseline})`)
  console.log('  by surface:', recent.map(r => `${r.surface}/${r.model.split('-').slice(0,2).join('-')}:${r.n}`).join(', '))
  expect(now, 'the live AI calls wrote usage rows').toBeGreaterThan(ids.usageBaseline)
})
