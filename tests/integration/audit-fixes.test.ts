// Locks in the v2.1.1 deep-audit fixes:
//  H9 — RLS lockdown: user policies are SELECT-only; a signed-in user can no
//       longer write rows directly via PostgREST (route validation, suspension,
//       and rate caps can't be bypassed).
//  A1 — grade_items_external_uniq is a full (inferable) index, so the Canvas
//       grade upsert actually writes rows and re-sync dedupes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL_ = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))

let authed: SupabaseClient
const service = createClient(URL_!, SERVICE!, { auth: { persistSession: false } })

beforeAll(async () => {
  authed = createClient(URL_!, ANON!, { auth: { persistSession: false } })
  const { error } = await authed.auth.signInWithPassword({
    email: 'teststudent@example.com',
    password: 'TestPassword123!',
  })
  if (error) throw new Error(`seed user sign-in failed: ${error.message}`)
})
afterAll(async () => { await authed.auth.signOut() })

describe('H9 — authenticated clients are read-only (writes only via service role)', () => {
  it('CANNOT raise their own daily_message_limit', async () => {
    const { data } = await authed.from('users')
      .update({ daily_message_limit: 1_000_000 }).eq('user_id', seed.userId).select()
    // RLS on UPDATE without a matching policy: zero rows affected, no error.
    expect(data ?? []).toHaveLength(0)
    const { data: row } = await service.from('users').select('daily_message_limit').eq('user_id', seed.userId).single()
    expect(row!.daily_message_limit).not.toBe(1_000_000)
  })

  it('CANNOT un-suspend themselves', async () => {
    const { data } = await authed.from('users')
      .update({ suspended: false }).eq('user_id', seed.userId).select()
    expect(data ?? []).toHaveLength(0)
  })

  it('CANNOT insert rows directly (flashcards)', async () => {
    const { error } = await authed.from('flashcards').insert({
      user_id: seed.userId, course_id: seed.courseA, front: 'injected', back: 'row',
    })
    expect(error, 'insert must be denied by RLS').not.toBeNull()
  })

  it('CANNOT reset their own usage counters', async () => {
    const { data } = await authed.from('daily_usage').delete().eq('user_id', seed.userId).select()
    expect(data ?? []).toHaveLength(0)
  })

  it('can still SELECT their own rows', async () => {
    const { data, error } = await authed.from('courses').select('course_id').eq('user_id', seed.userId)
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(0)
  })
})

describe('A1 — Canvas grade upsert works and dedupes (full unique index)', () => {
  const ext = 'canvas-test-asgmt-1'
  afterAll(async () => {
    await service.from('grade_items').delete().eq('user_id', seed.userId).eq('external_id', ext)
  })

  it('upsert with onConflict user_id,course_id,external_id inserts then updates', async () => {
    const row = {
      user_id: seed.userId, course_id: seed.courseA, category: 'Exams',
      name: 'Canvas Midterm', points_earned: 80, points_possible: 100,
      graded_at: new Date().toISOString(), source: 'canvas', external_id: ext,
    }
    const first = await service.from('grade_items').upsert(row, { onConflict: 'user_id,course_id,external_id' })
    expect(first.error, `first upsert failed: ${first.error?.message}`).toBeNull()

    // Re-sync with an updated score: must UPDATE the same row, not duplicate or 42P10.
    const second = await service.from('grade_items')
      .upsert({ ...row, points_earned: 85 }, { onConflict: 'user_id,course_id,external_id' })
    expect(second.error, `re-sync upsert failed: ${second.error?.message}`).toBeNull()

    const { data } = await service.from('grade_items')
      .select('points_earned').eq('user_id', seed.userId).eq('external_id', ext)
    expect(data).toHaveLength(1)
    expect(Number(data![0].points_earned)).toBe(85)
  })

  it('manual rows (NULL external_id) are unlimited (NULLS DISTINCT)', async () => {
    const base = {
      user_id: seed.userId, course_id: seed.courseA, category: 'Homework',
      points_earned: 9, points_possible: 10, graded_at: new Date().toISOString(), source: 'manual',
    }
    const a = await service.from('grade_items').insert({ ...base, name: 'audit-null-a' }).select('item_id').single()
    const b = await service.from('grade_items').insert({ ...base, name: 'audit-null-b' }).select('item_id').single()
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    await service.from('grade_items').delete().in('item_id', [a.data!.item_id, b.data!.item_id])
  })
})
