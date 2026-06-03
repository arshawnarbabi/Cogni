import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const ctx = await browser.newContext({ storageState: 'test-harness/.auth/state.json', baseURL: 'http://localhost:3001' })
const page = await ctx.newPage()
const msgs = []
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type().toUpperCase()}: ${m.text()}`) })
page.on('pageerror', e => msgs.push(`PAGEERROR: ${e.message}`))
page.on('requestfailed', r => msgs.push(`REQFAILED: ${r.url()} — ${r.failure()?.errorText}`))

for (const path of ['/today', '/courses', '/progress', '/settings', '/inbox']) {
  msgs.push(`\n--- ${path} ---`)
  await page.goto(path, { waitUntil: 'networkidle' }).catch(e => msgs.push('NAV ERROR: ' + e.message))
  await page.waitForTimeout(1200)
}
console.log(msgs.filter(m => m.trim()).join('\n') || 'NO CONSOLE ERRORS/WARNINGS')
await browser.close()
