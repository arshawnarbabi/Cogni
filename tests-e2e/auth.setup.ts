import { test as setup, expect } from '@playwright/test'
import { readFileSync, mkdirSync } from 'node:fs'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const STATE = 'test-harness/.auth/state.json'

setup('authenticate seeded student', async ({ page }) => {
  mkdirSync('test-harness/.auth', { recursive: true })

  await page.goto('/auth')
  await page.fill('#email', seed.email)
  await page.fill('#password', seed.password)

  const token = page.waitForResponse(r => r.url().includes('/auth/v1/token') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign in with email' }).click()
  const resp = await token
  expect(resp.ok(), 'sign-in token request should succeed').toBeTruthy()

  // Give the SSR cookie a beat to be written, then confirm we can reach an authed page.
  await page.waitForTimeout(1000)
  await page.goto('/today')
  await expect(page).toHaveURL(/\/today/)

  await page.context().storageState({ path: STATE })
})
