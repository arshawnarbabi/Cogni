import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

test.describe.configure({ mode: 'serial' })

test('middleware redirects an authenticated user off /auth to /today', async ({ page }) => {
  await page.goto('/auth')
  await expect(page).toHaveURL(/\/today/)
})

test('Today page renders for the seeded student (+ triggers the scheduler)', async ({ page }) => {
  await page.goto('/today')
  await expect(page.getByText(/Test Student/)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: 'test-harness/screenshots/today.png', fullPage: true })
})

test('scheduler produced a plan with NO misleading zero-card review task', async () => {
  const { data } = await db.from('study_plan').select('plan_date, tasks').eq('user_id', seed.userId)
  expect(data && data.length, 'a study plan should have been generated').toBeGreaterThan(0)
  const tasks = (data ?? []).flatMap((r: { tasks: unknown[] }) => r.tasks as Array<Record<string, unknown>>)
  const zeroCard = tasks.filter(t => t.type === 'flashcard_review' && t.card_count === 0)
  expect(zeroCard.length, 'no flashcard_review task with 0 cards').toBe(0)
})

test('Settings: a bad Anthropic key surfaces an error (not a false "Saved")', async ({ page }) => {
  await page.goto('/settings')
  const input = page.locator('input[placeholder="sk-ant-..."]')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill('badkey')
  await input.press('Enter')
  await expect(page.getByText(/invalid api key|failed to (save|store)/i)).toBeVisible({ timeout: 10_000 })
})

test('Deleting a course removes its data with no orphans and keeps the shared professor wiki', async ({ page }) => {
  const res = await page.request.delete(`/api/courses/${seed.courseA}`)
  expect(res.ok(), `course delete should succeed (got ${res.status()})`).toBeTruthy()

  const count = async (table: string, col: string, val: string) => {
    const { count } = await db.from(table).select('*', { count: 'exact', head: true }).eq(col, val)
    return count ?? 0
  }
  expect(await count('materials', 'course_id', seed.courseA), 'no orphan materials').toBe(0)
  expect(await count('course_files', 'course_id', seed.courseA), 'no orphan course_files').toBe(0)
  const { count: emb } = await db.from('material_embeddings').select('*', { count: 'exact', head: true }).eq('material_id', seed.materialId)
  expect(emb ?? 0, 'no orphan embeddings').toBe(0)

  const { data: course } = await db.from('courses').select('course_id').eq('course_id', seed.courseA).maybeSingle()
  expect(course, 'course row gone').toBeNull()

  // courseB still references the professor → the shared wiki must SURVIVE
  const { data: wiki } = await db.storage.from('wiki').download(seed.profWikiPath)
  expect(wiki, 'shared professor wiki should still exist').not.toBeNull()
})
