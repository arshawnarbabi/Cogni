import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000) // real model calls are slow

test('Tutor returns a real, on-topic streamed answer (Sonnet + RAG)', async ({ page }) => {
  const res = await page.request.post('/api/agents/tutor', {
    data: { courseId: seed.courseA, courseName: 'Physics 1', message: 'In one sentence, what is Newtons second law of motion?', mode: 'answer' },
    timeout: 100_000,
  })
  expect(res.ok(), `tutor HTTP ${res.status()}`).toBeTruthy()
  const body = await res.text()
  expect(body.length, 'streamed a non-trivial response').toBeGreaterThan(40)
  expect(/force|mass|accel/i.test(body), 'answer is on-topic for F=ma').toBe(true)

  // the assistant turn should have been persisted
  const { data: msgs } = await db.from('session_messages').select('role').eq('user_id', seed.userId).eq('role', 'assistant')
  expect((msgs ?? []).length, 'assistant message saved').toBeGreaterThan(0)
})

test('Inbox classifies an uploaded syllabus with real Haiku', async ({ page }) => {
  const syllabus = [
    'PHYSICS 101 — COURSE SYLLABUS',
    'Instructor: Professor Kandel',
    'Topics covered: Kinematics, Dynamics, Energy and Momentum.',
    'Grading: Midterm exam Oct 15 (30%), Final exam Dec 10 (40%), weekly problem sets (30%).',
  ].join('\n')

  const res = await page.request.post('/api/inbox/upload', {
    multipart: { file: { name: 'physics-syllabus.txt', mimeType: 'text/plain', buffer: Buffer.from(syllabus) } },
    timeout: 100_000,
  })
  expect(res.ok(), `upload HTTP ${res.status()}`).toBeTruthy()

  const { data } = await db.from('inbox_items').select('classification_status, tier, course_id').eq('user_id', seed.userId).order('created_at', { ascending: false }).limit(1)
  expect(data && data.length, 'an inbox item was created').toBeGreaterThan(0)
  // Haiku actually classified it (not stuck pending, not failed)
  expect(['classified', 'unassigned']).toContain(data![0].classification_status)
})
