// LIVE vision test — upload a real graded-exam image through the Inbox and
// confirm the REAL classifier (Haiku + vision) reads the score off it and
// creates a PENDING grade. Requires the test student's Anthropic key in vault.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
test.describe.configure({ mode: 'serial', timeout: 180_000 })

let db: pg.Client
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: DB }); await db.connect()
  const [k] = (await db.query("select count(*)::int n from vault.secrets where name like '%'||$1||'%'", [seed.userId]).catch(() => ({ rows: [{ n: 0 }] }))).rows
  if (!k || k.n === 0) throw new Error('NO ANTHROPIC KEY in the test vault — add it in the local Settings UI first.')
  // clean slate: no grade_items yet on the user's courses
  await db.query('delete from grade_items where user_id=$1', [seed.userId])
})
test.afterAll(async () => { await db?.end() })

test('vision reads 84/100 off the graded exam → a pending grade is created', async ({ request }) => {
  const img = readFileSync('test-harness/uploads/physics-midterm-graded.png')
  // Upload via the Inbox with NO course hint → the real classifier runs (a
  // course hint would skip classification, and with it the grade extraction).
  const res = await request.post('/api/inbox/upload', {
    multipart: { file: { name: 'physics-midterm-graded.png', mimeType: 'image/png', buffer: img } },
    timeout: 150_000,
  })
  expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  console.log(`  upload response: ${(await res.text()).slice(0, 200)}`)

  // classifyMaterial is awaited inside the upload, so the pending grade should
  // exist by now; poll briefly to absorb any timing.
  let row: { name: string; category: string | null; points_earned: number; points_possible: number; course: string } | undefined
  for (let i = 0; i < 20; i++) {
    const rows = (await db.query(
      `select g.name, g.category, g.points_earned::float pe, g.points_possible::float pp, c.name course
       from grade_items g join courses c on c.course_id = g.course_id
       where g.user_id=$1 and g.source='upload' and g.confirmed=false
       order by g.created_at desc limit 1`, [seed.userId])).rows
    if (rows[0]) { row = { ...rows[0], points_earned: rows[0].pe, points_possible: rows[0].pp }; break }
    await new Promise(r => setTimeout(r, 2500))
  }

  expect(row, 'a pending upload grade should have been extracted').toBeTruthy()
  console.log(`  ✓ EXTRACTED: "${row!.name}" ${row!.points_earned}/${row!.points_possible} · category=${row!.category ?? 'none'} · course=${row!.course}`)

  // The circled "84/100" is unambiguous — assert it landed correctly.
  expect(row!.points_possible).toBe(100)
  expect(row!.points_earned).toBeGreaterThanOrEqual(80)
  expect(row!.points_earned).toBeLessThanOrEqual(88)

  // And it's PENDING, not counted — verify via the real grades API for its course.
  const courseId = (await db.query("select course_id from grade_items where user_id=$1 and source='upload' limit 1", [seed.userId])).rows[0].course_id
  const g = await (await request.get(`/api/grades?courseId=${courseId}`)).json()
  expect(g.pending.length, 'shows in the pending strip').toBeGreaterThanOrEqual(1)
  expect(g.summary.current_pct, 'not counted until confirmed').toBeNull()
  console.log(`  ✓ pending=${g.pending.length}, counted grade=${g.summary.current_pct} (correctly excluded)`)
})
