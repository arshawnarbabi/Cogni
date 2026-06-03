import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

describe('consume_daily_quota — per-user daily rate limit', () => {
  it('allows up to the limit, then denies', async () => {
    const action = 'test_' + Math.random().toString(36).slice(2) // fresh action so the day count starts at 0
    const r1 = await db.rpc('consume_daily_quota', { p_user_id: seed.userId, p_action: action, p_limit: 2 })
    const r2 = await db.rpc('consume_daily_quota', { p_user_id: seed.userId, p_action: action, p_limit: 2 })
    const r3 = await db.rpc('consume_daily_quota', { p_user_id: seed.userId, p_action: action, p_limit: 2 })
    expect(r1.data).toBe(true)   // count 1 <= 2
    expect(r2.data).toBe(true)   // count 2 <= 2
    expect(r3.data).toBe(false)  // count 3 > 2 → denied
  })

  it('is not callable by anon (service-role only)', async () => {
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const { error } = await anon.rpc('consume_daily_quota', { p_user_id: seed.userId, p_action: 'x', p_limit: 1 })
    expect(error).not.toBeNull()
  })
})
