// Post-audit smoke: every heavily-patched page renders without client errors.
import { test, expect } from '@playwright/test'

const PAGES = ['/today', '/tutor', '/courses', '/inbox', '/progress', '/settings']

for (const path of PAGES) {
  test(`smoke ${path} — renders, no page errors`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(path, { waitUntil: 'networkidle', timeout: 40_000 })
    await page.waitForTimeout(800)
    expect(errors, `client errors on ${path}: ${errors.join(' | ')}`).toHaveLength(0)
    // the shell rendered (sidebar nav present)
    await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible()
  })
}
