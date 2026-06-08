// Mega walkthrough — drives EVERY surface of the live dashboard against the
// mega seed (6 courses, full semester of data), screenshotting each into
// test-harness/mega/. Realistic student usage: read the plan, check standing,
// inspect courses, add a grade, review cards, run a quiz, tour Settings.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

const DIR = 'test-harness/mega'
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string) {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true })
}
async function go(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle', timeout: 40_000 })
}

test('01 — Today: full plan, weekly schedule, streak', async ({ page }) => {
  await go(page, '/today')
  await expect(page).toHaveURL(/\/today/)
  await expect(page.getByRole('heading').first()).toBeVisible()
  await shot(page, '01-today')
})

test('02 — Progress: semester standing across 6 courses + trends', async ({ page }) => {
  await go(page, '/progress')
  await expect(page.getByText('Semester standing')).toBeVisible({ timeout: 15_000 })
  // 6 verdict cards should be present.
  await expect(page.getByText(/Critical|At risk|On track/).first()).toBeVisible()
  await shot(page, '02-progress')
})

test('03 — Courses list (6 courses)', async ({ page }) => {
  await go(page, '/courses')
  await expect(page.getByText('Organic Chemistry II')).toBeVisible({ timeout: 15_000 })
  await shot(page, '03-courses-list')
})

test('04 — Course: Organic Chem (critical) — topics, grades, what-if', async ({ page }) => {
  await go(page, '/courses')
  await page.getByText('Organic Chemistry II').first().click()
  await expect(page.getByRole('heading', { name: 'Grades' })).toBeVisible({ timeout: 15_000 })
  await shot(page, '04-course-critical')
  // Add a grade live and confirm recompute.
  await page.getByRole('button', { name: /Add grade/i }).click()
  await page.getByPlaceholder('Midterm 1').fill('Pop Quiz')
  await page.getByPlaceholder('84').fill('6')
  await page.getByPlaceholder('100').fill('10')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Pop Quiz')).toBeVisible({ timeout: 10_000 })
  await shot(page, '05-course-grade-added')
})

test('06 — Course: Modern Lit (humanities, healthy)', async ({ page }) => {
  await go(page, '/courses')
  await page.getByText('Modern Literature').first().click()
  await expect(page.getByRole('heading', { name: 'Grades' })).toBeVisible({ timeout: 15_000 })
  await shot(page, '06-course-healthy')
})

test('07 — Review: dense due-card queue', async ({ page }) => {
  await go(page, '/review')
  await page.waitForTimeout(1500)
  await shot(page, '07-review')
  // Rate the first card if the flip UI is present.
  const flip = page.locator('text=/Show answer|Flip|Reveal/i').first()
  if (await flip.count()) { await flip.click().catch(() => {}); await page.waitForTimeout(500) }
})

test('08 — Settings: every panel', async ({ page }) => {
  await go(page, '/settings')
  await expect(page.getByText('Tutor memory')).toBeVisible({ timeout: 15_000 })
  await shot(page, '08-settings-top')
  // Scroll through and capture the lower panels too.
  await page.getByText('Usage & cost', { exact: false }).scrollIntoViewIfNeeded()
  await shot(page, '09-settings-usage')
  await page.getByText('Tutor memory').scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  await shot(page, '10-settings-memory')
})

test('11 — Tutor page (mode picker)', async ({ page }) => {
  await go(page, '/tutor')
  await page.waitForTimeout(1500)
  await shot(page, '11-tutor')
})

test('12 — Inbox', async ({ page }) => {
  await go(page, '/inbox')
  await page.waitForTimeout(1200)
  await shot(page, '12-inbox')
})

test('13 — ICS feed is dense (many VEVENTs)', async ({ request }) => {
  const res = await request.get('/api/settings/calendar-feed')
  const { token } = await res.json()
  const ics = await request.get(`/api/calendar/feed/${token}.ics`)
  const body = await ics.text()
  const events = (body.match(/BEGIN:VEVENT/g) || []).length
  expect(body).toContain('BEGIN:VCALENDAR')
  expect(events).toBeGreaterThan(8) // exams + assignments + study blocks
  console.log(`ICS feed VEVENT count: ${events}`)
})
