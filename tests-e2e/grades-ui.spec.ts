// UI walkthrough for the grade-input on-ramps — drives the real Grades panel
// and screenshots each state: pending strip → confirm → manual mode → revert.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

const DIR = 'test-harness/grades-ui'
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
// Self-seeding so the serial (state-mutating) walkthrough is re-runnable: a
// scheme + two confirmed grades + one PENDING upload grade on courseA.
test.beforeAll(async () => {
  mkdirSync(DIR, { recursive: true })
  const db = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })
  await db.connect()
  await db.query('delete from grade_items where course_id=$1', [seed.courseA])
  await db.query('delete from course_grade_manual where course_id=$1', [seed.courseA])
  await db.query('delete from course_grade_schemes where course_id=$1', [seed.courseA])
  await db.query("insert into course_grade_schemes(user_id,course_id,category,weight_pct) values ($1,$2,'Exams',50),($1,$2,'Homework',30),($1,$2,'Participation',20)", [seed.userId, seed.courseA])
  await db.query("insert into grade_items(user_id,course_id,category,name,points_earned,points_possible,source,confirmed) values ($1,$2,'Exams','Midterm 1',82,100,'manual',true),($1,$2,'Homework','PSet 1',17,20,'manual',true),($1,$2,'Exams','Midterm 2 (scan)',91,100,'upload',false)", [seed.userId, seed.courseA])
  await db.end()
})
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 1000 } })

async function gotoGrades(page: Page) {
  await page.goto(`/courses/${seed.courseA}`, { waitUntil: 'networkidle', timeout: 40_000 })
  await page.getByRole('heading', { name: 'Grades' }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(700)
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true })
}

test('01 — pending upload grade shows in the confirm strip, not counted', async ({ page }) => {
  await gotoGrades(page)
  await expect(page.getByText(/Found 1 grade in your uploads/i)).toBeVisible()
  await expect(page.getByText('Midterm 2 (scan)')).toBeVisible()
  await shot(page, '01-pending-strip')
})

test('02 — confirm the pending grade → it counts', async ({ page }) => {
  await gotoGrades(page)
  await page.getByRole('button', { name: 'Confirm' }).first().click()
  await expect(page.getByText(/Found 1 grade in your uploads/i)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText('Midterm 2 (scan)')).toBeVisible() // now in the counted list
  await shot(page, '02-confirmed')
})

test('03 — switch to the manual "just enter your grade" path', async ({ page }) => {
  await gotoGrades(page)
  await page.getByText(/enter your current grade/i).click()
  await page.getByPlaceholder('84').fill('88')
  await page.getByPlaceholder(/30/).fill('25')
  await shot(page, '03-manual-form')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Grade entered manually/i)).toBeVisible({ timeout: 10_000 })
  await shot(page, '04-manual-mode')
})

test('05 — revert to tracking restores the item-based grade', async ({ page }) => {
  await gotoGrades(page)
  await page.getByRole('button', { name: /Switch to tracking/i }).click()
  await expect(page.getByText('Midterm 1')).toBeVisible({ timeout: 10_000 })
  await shot(page, '05-back-to-tracked')
})
