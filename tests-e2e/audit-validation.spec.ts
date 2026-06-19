// End-to-end proof that the input-validation fixes (#33-39, G3) actually fire:
// hostile/malformed input must return a 4xx the route chose, NOT an unhandled
// 500 from the DB/runtime. Runs against the real routes with the seeded session.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const not500 = (status: number) => status >= 400 && status < 500

test('#36 grades POST: Infinity points (JSON 1e999) → 400, not a numeric-overflow 500', async ({ request }) => {
  const res = await request.post('/api/grades', {
    headers: { 'content-type': 'application/json' },
    data: '{"courseId":"' + seed.courseA + '","name":"x","points_possible":1e999,"points_earned":1}',
  })
  expect(not500(res.status()), `got ${res.status()}`).toBe(true)
  expect(res.status()).toBe(400)
})

test('#37 grades POST: malformed JSON body → 400 invalid_json, not 500', async ({ request }) => {
  const res = await request.post('/api/grades', { headers: { 'content-type': 'application/json' }, data: '{not valid json' })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toBe('invalid_json')
})

test('#34 exam score PATCH: non-numeric score → 400, not a numeric-column 500', async ({ request }) => {
  const res = await request.patch(`/api/courses/${seed.courseA}/exams/${seed.examId}`, {
    data: { student_score: 'abc' },
  })
  expect(not500(res.status()), `got ${res.status()}`).toBe(true)
  expect(res.status()).toBe(400)
})

test('#35 assignments POST: unparseable due_date → 400, not a timestamp 500', async ({ request }) => {
  const res = await request.post('/api/assignments', {
    data: { courseId: seed.courseA, name: 'HW', due_date: 'definitely-not-a-date' },
  })
  expect(not500(res.status()), `got ${res.status()}`).toBe(true)
  expect(res.status()).toBe(400)
})

test('#33 tutor POST: unknown mode → 400 invalid_mode (no CHECK-violation 500)', async ({ request }) => {
  const res = await request.post('/api/agents/tutor', {
    data: { courseId: seed.courseA, courseName: 'Physics 1', message: 'hi', mode: 'h4ck' },
  })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toBe('invalid_mode')
})

test('G3 tutor-limit PATCH: 1e9 is rejected → 400 (anti-abuse cap cannot be self-disabled)', async ({ request }) => {
  const res = await request.patch('/api/settings/tutor-limit', { data: { daily_message_limit: 1_000_000_000 } })
  expect(res.status()).toBe(400)
  // and the stored value did not change to the huge number
  const { data } = await db.from('users').select('daily_message_limit').eq('user_id', seed.userId).single()
  expect(data!.daily_message_limit ?? 0).toBeLessThanOrEqual(500)
})

test('H11 GDPR export: users.calendar_feed_token is redacted', async ({ request }) => {
  await db.from('users').update({ calendar_feed_token: 'live-feed-token-secret-xyz' }).eq('user_id', seed.userId)
  const res = await request.get('/api/user/export')
  expect(res.ok(), `export HTTP ${res.status()}`).toBeTruthy()
  const body = await res.json()
  const usersRows = body.tables?.users ?? []
  expect(usersRows.length).toBeGreaterThan(0)
  for (const row of usersRows) {
    if ('calendar_feed_token' in row) {
      expect(row.calendar_feed_token, 'feed token must be redacted in export').toBe('[redacted]')
    }
  }
  // raw token must not appear anywhere in the export payload
  expect(JSON.stringify(body)).not.toContain('live-feed-token-secret-xyz')
})
