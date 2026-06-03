import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Live coverage for the production-hardening flows (run LAST, after the live-AI
// specs — several tests mutate app_config / users.suspended and reset in finally,
// so isolating them avoids interfering with the AI specs).
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test('legal pages are public + render', async ({ page }) => {
  for (const path of ['/legal/terms', '/legal/privacy', '/legal/acceptable-use']) {
    const res = await page.request.get(path)
    expect(res.ok(), `${path} -> HTTP ${res.status()}`).toBeTruthy()
    expect((await res.text()).length).toBeGreaterThan(200)
  }
})

test('public auth config reports open signup mode', async ({ page }) => {
  const res = await page.request.get('/api/auth/config')
  expect(res.ok()).toBeTruthy()
  expect((await res.json()).signupMode).toBe('open')
})

test('signup route rejects missing consent (400 consent_required)', async ({ page }) => {
  const res = await page.request.post('/api/auth/signup', {
    data: { email: 'noconsent@example.com', password: 'password123', acceptedTerms: false, ageAttested: false },
  })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toBe('consent_required')
})

test('signups_paused blocks the signup route (403)', async ({ page }) => {
  try {
    await db.from('app_config').update({ signups_paused: true }).eq('id', true)
    const res = await page.request.post('/api/auth/signup', {
      data: { email: `paused_${Date.now()}@example.com`, password: 'password123', acceptedTerms: true, ageAttested: true },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).error).toBe('signups_paused')
  } finally {
    await db.from('app_config').update({ signups_paused: false }).eq('id', true)
  }
})

test('operator route: 401 without the secret, 200 with it', async ({ page }) => {
  const noSecret = await page.request.get('/api/operator')
  expect(noSecret.status(), 'no secret -> 401').toBe(401)
  const withSecret = await page.request.get('/api/operator', { headers: { 'x-operator-secret': process.env.OPERATOR_SECRET! } })
  expect(withSecret.ok(), `with secret -> HTTP ${withSecret.status()}`).toBeTruthy()
})

test('suspended user is blocked from AI routes (403) + audited, then unsuspended', async ({ page }) => {
  try {
    const susp = await page.request.post('/api/operator', {
      headers: { 'x-operator-secret': process.env.OPERATOR_SECRET! },
      data: { userId: seed.userId, suspended: true, reason: 'live-test' },
    })
    expect(susp.ok(), 'suspend via operator route').toBeTruthy()

    const ai = await page.request.post('/api/flashcards/generate', {
      data: { courseId: seed.courseA, topicId: seed.topics.kinematics },
    })
    expect(ai.status(), 'suspended -> AI route 403').toBe(403)

    const { data: audit } = await db.from('audit_log').select('action').eq('subject_user_id', seed.userId).eq('action', 'suspend_user')
    expect((audit ?? []).length, 'suspend was audited').toBeGreaterThan(0)
  } finally {
    await db.rpc('operator_set_suspended', { p_user_id: seed.userId, p_suspended: false, p_reason: 'reset' })
  }
})

test('ai_disabled kill-switch returns 503 from the Tutor', async ({ page }) => {
  try {
    await db.from('app_config').update({ ai_disabled: true }).eq('id', true)
    const res = await page.request.post('/api/agents/tutor', {
      data: { courseId: seed.courseA, courseName: 'Physics 1', message: 'hello', mode: 'answer' },
    })
    expect(res.status(), 'kill-switch -> 503').toBe(503)
  } finally {
    await db.from('app_config').update({ ai_disabled: false }).eq('id', true)
  }
})

test('GDPR export returns the user data + redacts secret columns', async ({ page }) => {
  const res = await page.request.get('/api/user/export')
  expect(res.ok(), `export HTTP ${res.status()}`).toBeTruthy()
  const j = await res.json()
  expect(j.tables, 'export has tables').toBeTruthy()
  expect(Array.isArray(j.tables.courses), 'courses present').toBe(true)
  expect(j.tables.courses.length, 'export is NOT empty (catalog RPC works)').toBeGreaterThan(0)
  const uk = j.tables.user_keys
  if (Array.isArray(uk)) {
    for (const row of uk) if ('key_value' in row) expect(row.key_value, 'BYOK secret redacted').toBe('[redacted]')
  }
})

test('image moderation runs and does NOT block a benign image (no 422)', async ({ page }) => {
  // 1x1 transparent PNG — benign content; moderation should not flag it.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const res = await page.request.post('/api/inbox/upload', {
    multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: png } },
  })
  // Moderation runs before storage; a benign image must NOT be rejected (422).
  expect(res.status(), 'benign image not moderation-blocked').not.toBe(422)
})
