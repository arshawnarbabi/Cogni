// Showcase walkthrough — drives the LIVE dashboard (local stack, seeded
// showcase data) through every feature built this update, screenshotting each
// surface into test-harness/showcase/. Run after seed.mjs + seed-showcase.mjs.
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const DIR = 'test-harness/showcase'
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))

// Uses the authenticated storage state from auth.setup.ts (the seeded student).
test.describe.configure({ mode: 'serial' })

async function shot(page: import('@playwright/test').Page, name: string) {
  await page.waitForTimeout(700) // let animations settle
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true })
}

test('01 — Today dashboard (plan, streak, banners)', async ({ page }) => {
  await page.goto('/today')
  await expect(page).toHaveURL(/\/today/)
  await expect(page.getByRole('heading').first()).toBeVisible()
  await shot(page, '01-today')
})

test('02 — Progress: Semester standing (verdicts)', async ({ page }) => {
  await page.goto('/progress')
  // The S15 section we built — at-risk Physics 1, healthy Physics 2.
  await expect(page.getByText('Semester standing')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/At risk|Critical|On track/).first()).toBeVisible()
  await shot(page, '02-semester-standing')
})

test('03 — Course page: Grade tracker + what-if', async ({ page }) => {
  // Find the at-risk course (Physics 1) from the courses list.
  await page.goto('/courses')
  await page.getByText('Physics 1').first().click()
  await expect(page.getByRole('heading', { name: 'Grades' })).toBeVisible({ timeout: 10_000 })
  // The current grade + the what-if line ("need X% on the rest").
  await expect(page.getByText(/current grade/i)).toBeVisible()
  await shot(page, '03-grades-before')

  // Interact: add a grade and watch the numbers recompute.
  await page.getByRole('button', { name: /Add grade/i }).click()
  await page.getByPlaceholder('Midterm 1').fill('Quiz 1')
  await page.getByPlaceholder('84').fill('9')
  await page.getByPlaceholder('100').fill('10')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Quiz 1')).toBeVisible({ timeout: 10_000 })
  await shot(page, '04-grades-after-add')
})

test('05 — Settings: Memory center, Usage & cost, Calendar feed, Canvas', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByText('Tutor memory')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Usage & cost', { exact: false })).toBeVisible()
  await expect(page.getByText('Calendar feed', { exact: false })).toBeVisible()
  await expect(page.getByText('Canvas import')).toBeVisible()
  await shot(page, '05-settings-full')

  // Scroll the memory center into view (it has seeded content).
  await page.getByText('Tutor memory').scrollIntoViewIfNeeded()
  await expect(page.getByText(/course memory|things the tutor noted/i).first()).toBeVisible()
  await shot(page, '06-memory-center')
})

test('07 — ICS calendar feed serves a valid VCALENDAR', async ({ page, request }) => {
  // Read the seeded feed token straight from the connection panel’s API.
  const res = await request.get('/api/settings/calendar-feed')
  const { token } = await res.json()
  expect(token).toBeTruthy()
  const ics = await request.get(`/api/calendar/feed/${token}.ics`)
  expect(ics.ok()).toBeTruthy()
  const body = await ics.text()
  expect(body).toContain('BEGIN:VCALENDAR')
  expect(body).toContain('END:VCALENDAR')
})

test('08 — Review queue renders due cards', async ({ page }) => {
  await page.goto('/review?course=' + process.env.SHOWCASE_COURSE_A)
  // Either cards render or it redirects when none due — both are valid; capture.
  await page.waitForTimeout(1200)
  await shot(page, '08-review')
})
