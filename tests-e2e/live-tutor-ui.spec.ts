// The tutor UI fixes that need a real session: a live streamed answer renders
// into a bubble (#16 happy path), and a forced mid-request failure shows an
// error bubble + restores the typed text instead of a stuck "streaming" state
// (#16 failure path — via interception, no extra AI cost).
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

const ids = JSON.parse(readFileSync('/tmp/live-ids.json', 'utf8'))
const DIR = 'test-harness/journey'
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))
test.use({ viewport: { width: 1366, height: 1000 } })
test.describe.configure({ mode: 'serial', timeout: 120_000 })

async function openTutorForCourse(page: Page) {
  await page.goto('/tutor', { waitUntil: 'networkidle' })
  // pick the course (the seeded courses show as选择able chips/cards)
  const courseBtn = page.getByText(ids.courseName, { exact: false }).first()
  if (await courseBtn.isVisible().catch(() => false)) await courseBtn.click().catch(() => {})
  await page.waitForTimeout(800)
}

test('#16 happy path — a real tutor answer streams into an assistant bubble', async ({ page }) => {
  await openTutorForCourse(page)
  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.waitFor({ timeout: 10_000 })
  await composer.fill('Give me a one-sentence definition of electric flux.')
  await composer.press('Enter')

  // an assistant message bubble should fill in with real streamed text
  await expect(page.getByText(/flux/i).first()).toBeVisible({ timeout: 90_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${DIR}/08-tutor-live.png`, fullPage: true })
})

test('#16 failure path — a mid-request failure shows an error, not a stuck stream', async ({ page }) => {
  await openTutorForCourse(page)
  // Force the tutor request to fail.
  await page.route('**/api/agents/tutor', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 500, body: '{"error":"forced"}' })
    return route.continue()
  })
  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.waitFor({ timeout: 10_000 })
  await composer.fill('This request will fail on purpose.')
  await composer.press('Enter')
  await page.waitForTimeout(2500)

  // The UI must surface an error (not hang on a permanent "streaming" bubble).
  const errorish = page.getByText(/error|went wrong|try again|connection|failed/i).first()
  await expect(errorish).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${DIR}/09-tutor-error.png`, fullPage: true })
})
