// Real (non-mock) quiz + simulated-exam generation. Requires the dev server to
// run WITHOUT MOCK_AGENTS so the routes hit Claude. Also verifies the #32 fix:
// a huge client questionCount is clamped server-side.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const asArray = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body
  if (body && Array.isArray((body as { questions?: unknown[] }).questions)) return (body as { questions: unknown[] }).questions
  return []
}

test('Practice quiz: real Haiku generation, questionCount clamped to <=20 (fix #32)', async ({ page }) => {
  const res = await page.request.post('/api/agents/practice-quiz', {
    data: { courseId: seed.courseA, courseName: 'Physics 1', questionCount: 9999, format: 'mixed', difficulty: 'medium' },
    timeout: 120_000,
  })
  expect(res.ok(), `quiz HTTP ${res.status()}`).toBeTruthy()
  const qs = asArray(await res.json())
  expect(qs.length, 'generated some questions').toBeGreaterThan(0)
  expect(qs.length, 'server clamped the count to <= 20 (fits the token budget)').toBeLessThanOrEqual(20)
})

test('Simulated exam: real Sonnet generation returns questions', async ({ page }) => {
  const res = await page.request.post('/api/agents/simulated-exam', {
    data: { courseId: seed.courseA, courseName: 'Physics 1' },
    timeout: 140_000,
  })
  expect(res.ok(), `exam HTTP ${res.status()}`).toBeTruthy()
  const qs = asArray(await res.json())
  expect(qs.length, 'generated exam questions').toBeGreaterThan(0)
})
