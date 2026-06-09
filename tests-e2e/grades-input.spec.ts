// Functional E2E for the grade-input on-ramps (F1 + F2) — deterministic, no AI.
// Drives the real /api/grades + /api/grades/manual routes with the authenticated
// session, and asserts the confirmed-filter and the manual override end to end.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const courseId: string = seed.courseA
test.describe.configure({ mode: 'serial' })

let db: pg.Client
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: DB }); await db.connect()
  // Clean slate for this course's grades + a simple scheme to test weighting.
  await db.query('delete from grade_items where course_id=$1', [courseId])
  await db.query('delete from course_grade_manual where course_id=$1', [courseId])
  await db.query('delete from course_grade_schemes where course_id=$1', [courseId])
  await db.query(
    "insert into course_grade_schemes(user_id,course_id,category,weight_pct) values ($1,$2,'Exams',50),($1,$2,'Homework',50)",
    [seed.userId, courseId])
})
test.afterAll(async () => { await db?.end() })

async function getGrades(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get(`/api/grades?courseId=${courseId}`)
  expect(res.ok(), `GET /api/grades failed: ${res.status()}`).toBeTruthy()
  return res.json()
}

test('F1 — a pending (unconfirmed) upload grade does NOT count, then counts once confirmed', async ({ request }) => {
  // Simulate the classifier having extracted a grade from an upload.
  await db.query(
    "insert into grade_items(user_id,course_id,category,name,points_earned,points_possible,source,confirmed) values ($1,$2,'Exams','Midterm (from upload)',80,100,'upload',false)",
    [seed.userId, courseId])

  let d = await getGrades(request)
  expect(d.pending.length, 'pending strip should hold the unconfirmed item').toBe(1)
  expect(d.items.length, 'unconfirmed item must NOT be in the counted items').toBe(0)
  expect(d.summary.current_pct, 'grade must not move from an unconfirmed item').toBeNull()
  console.log(`  pending=1, counted=0, grade=${d.summary.current_pct} ✓`)

  // Confirm it via the real PATCH route.
  const itemId = d.pending[0].item_id
  const res = await request.patch('/api/grades', { data: { itemId, confirmed: true } })
  expect(res.ok()).toBeTruthy()

  d = await getGrades(request)
  expect(d.pending.length, 'no longer pending after confirm').toBe(0)
  expect(d.items.length).toBe(1)
  expect(d.summary.current_pct, 'now counts: Exams 80% over the graded half → 80').toBe(80)
  console.log(`  after confirm: counted=1, grade=${d.summary.current_pct}% ✓`)
})

test('F2 — manual class-grade input drives the grade + what-if, then reverts', async ({ request }) => {
  // 84% with 30% of the grade still ungraded.
  const put = await request.put('/api/grades/manual', { data: { courseId, current_pct: 84, remaining_weight_pct: 30 } })
  expect(put.ok()).toBeTruthy()

  let d = await getGrades(request)
  expect(d.mode).toBe('manual')
  expect(d.summary.mode).toBe('manual')
  expect(d.summary.current_pct).toBe(84)
  // what-if from the two fields: 80% → ~70.7% needed on the rest.
  const w80 = d.whatIf.find((w: { target_pct: number }) => w.target_pct === 80)
  expect(w80.needed_pct).toBeGreaterThan(68)
  expect(w80.needed_pct).toBeLessThan(73)
  console.log(`  manual mode: grade=${d.summary.current_pct}%, 80%→need ${w80.needed_pct}% ✓`)

  // Revert to tracking — the confirmed item from the prior test counts again.
  const del = await request.delete('/api/grades/manual', { data: { courseId } })
  expect(del.ok()).toBeTruthy()
  d = await getGrades(request)
  expect(d.mode).toBe('tracked')
  expect(d.summary.current_pct).toBe(80) // back to the item-based grade
  console.log(`  reverted to tracked: grade=${d.summary.current_pct}% ✓`)
})
