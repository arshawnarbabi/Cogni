// Behavioral coverage for audit fixes that previously had NONE — the race-
// safety constraints (Section 22) and the canvas_token allowlist (G2). These
// assert the fix actually changes runtime behavior, not just that it compiles.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env.SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const isUniqueViolation = (e: { code?: string } | null) => e?.code === '23505'

describe('Section 22 — race-safety constraints reject duplicates (audit #4/#5/#26/#27)', () => {
  afterEach(async () => {
    await db.from('jobs').delete().eq('user_id', seed.userId).eq('subject_id', seed.courseA)
    await db.from('jobs').delete().eq('user_id', seed.userId).is('subject_id', null)
    await db.from('exams').delete().eq('user_id', seed.userId).eq('date', '2099-12-01')
    await db.from('materials').delete().eq('user_id', seed.userId).like('filename', 'race-test-%')
    await db.from('course_grade_schemes').delete().eq('user_id', seed.userId).eq('course_id', seed.courseA).eq('category', 'RaceCat')
  })

  it('#5/#27 jobs: a second identical QUEUED job is rejected (one dedup per user/kind/course)', async () => {
    const row = { user_id: seed.userId, kind: 'flashcards', subject_id: null, payload: { courseId: seed.courseA }, status: 'queued' }
    const a = await db.from('jobs').insert(row)
    expect(a.error, `first insert: ${a.error?.message}`).toBeNull()
    const b = await db.from('jobs').insert(row)
    expect(isUniqueViolation(b.error), 'duplicate queued job must be rejected').toBe(true)
  })

  it('#5/#27 jobs: the dedup is PARTIAL — a running job does not block a fresh queued one', async () => {
    const base = { user_id: seed.userId, kind: 'flashcards', subject_id: null, payload: { courseId: seed.courseA } }
    const running = await db.from('jobs').insert({ ...base, status: 'running' })
    expect(running.error).toBeNull()
    const queued = await db.from('jobs').insert({ ...base, status: 'queued' })
    expect(queued.error, 'queued job should coexist with a running one').toBeNull()
  })

  it('#5/#27 jobs: different courseId payloads are NOT duplicates', async () => {
    const a = await db.from('jobs').insert({ user_id: seed.userId, kind: 'flashcards', payload: { courseId: seed.courseA }, status: 'queued' })
    const b = await db.from('jobs').insert({ user_id: seed.userId, kind: 'flashcards', payload: { courseId: seed.courseB }, status: 'queued' })
    expect(a.error).toBeNull()
    expect(b.error, 'distinct courses are distinct jobs').toBeNull()
  })

  it('#26 exams: a duplicate (user, course, date) is rejected', async () => {
    const row = { user_id: seed.userId, course_id: seed.courseA, date: '2099-12-01' }
    const a = await db.from('exams').insert(row)
    expect(a.error, `first exam: ${a.error?.message}`).toBeNull()
    const b = await db.from('exams').insert(row)
    expect(isUniqueViolation(b.error), 'duplicate exam must be rejected').toBe(true)
  })

  it('#4 materials: two ACTIVE rows with the same filename collide; a FAILED one does not block', async () => {
    const a = await db.from('materials').insert({ user_id: seed.userId, filename: 'race-test-a.pdf', processing_status: 'processed' })
    expect(a.error, `first material: ${a.error?.message}`).toBeNull()
    const dup = await db.from('materials').insert({ user_id: seed.userId, filename: 'race-test-a.pdf', processing_status: 'processed' })
    expect(isUniqueViolation(dup.error), 'duplicate active material must be rejected').toBe(true)

    // A failed row of a different name, then a new active upload of THAT name, must succeed
    // (the partial index excludes processing_status = 'failed' so retries aren't blocked).
    await db.from('materials').insert({ user_id: seed.userId, filename: 'race-test-b.pdf', processing_status: 'failed' })
    const retry = await db.from('materials').insert({ user_id: seed.userId, filename: 'race-test-b.pdf', processing_status: 'processed' })
    expect(retry.error, 'a retry past a failed row must be allowed').toBeNull()
  })

  it('#6 grade scheme: a duplicate category is rejected by the unique constraint', async () => {
    const row = { user_id: seed.userId, course_id: seed.courseA, category: 'RaceCat', weight_pct: 10 }
    const a = await db.from('course_grade_schemes').insert(row)
    expect(a.error, `first category: ${a.error?.message}`).toBeNull()
    const b = await db.from('course_grade_schemes').insert(row)
    expect(isUniqueViolation(b.error), 'duplicate category must be rejected').toBe(true)
  })
})

describe('G2 — canvas_token round-trips through the vault (Canvas integration restored)', () => {
  // The bug: ALLOWED_KEYS lacked 'canvas_token', so setUserKey threw
  // 'Unsupported key' (Canvas connect 500'd) and getUserKey returned null
  // (sync silently no-op'd). Prove both directions work now.
  let setUserKey: (u: string, k: string, v: string) => Promise<void>
  let getUserKey: (u: string, k: string) => Promise<string | null>
  let deleteUserKey: (u: string, k: string) => Promise<void>

  beforeAll(async () => {
    // lib/supabase/server's createServiceClient reads the NEXT_PUBLIC_* names.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= process.env.SUPABASE_ANON_KEY
    const mod = await import('@/lib/user-keys')
    setUserKey = mod.setUserKey
    getUserKey = mod.getUserKey
    deleteUserKey = mod.deleteUserKey
  })
  afterEach(async () => { await deleteUserKey(seed.userId, 'canvas_token').catch(() => {}) })

  it('setUserKey does not throw for canvas_token, and getUserKey reads it back', async () => {
    await expect(setUserKey(seed.userId, 'canvas_token', 'canvas-tok-abc123')).resolves.toBeUndefined()
    expect(await getUserKey(seed.userId, 'canvas_token')).toBe('canvas-tok-abc123')
  })

  it('an unknown key name still fails closed (allowlist intact)', async () => {
    await expect(setUserKey(seed.userId, 'totally_unknown_key', 'x')).rejects.toThrow()
    expect(await getUserKey(seed.userId, 'totally_unknown_key')).toBeNull()
  })
})
