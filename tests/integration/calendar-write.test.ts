// End-to-end proof that "adding to the calendar" works AND is conflict-aware:
// drives the real writeStudyBlocksToCalendar against a MOCKED Google Calendar
// API (freeBusy + event create/list/delete), with a seeded google connection.
// No real Google account needed; the only thing stubbed is Google's HTTP.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const H = 60 * 60_000
const tz = seed.timezone ?? 'UTC'

let writeStudyBlocksToCalendar: (u: string, t: { course_name: string; duration_minutes: number; order: number }[]) => Promise<void>
let startOfLocalDayUtc: (d: string, tz: string) => Date
let dateKeyInTimeZone: (d: Date, tz: string) => string
const db = new Client({ connectionString: DB })

// Capture what gets POSTed to Google; pass DB/supabase calls through to real fetch.
let created: { summary: string; start: string; end: string }[] = []
let listedBeforeCreate = false
const realFetch = globalThis.fetch

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= process.env.SUPABASE_ANON_KEY
  await db.connect()
  // Seed a non-expired google connection with a pre-made Cogni calendar id.
  await db.query("delete from calendar_connections where user_id=$1 and provider='google'", [seed.userId])
  await db.query(
    `insert into calendar_connections(user_id, provider, access_token, refresh_token, expires_at, cogni_calendar_id, created_at)
     values ($1,'google','fake-access','fake-refresh', now() + interval '1 hour', 'cogni-test-cal', now())`,
    [seed.userId])
  await db.query("select store_user_secret($1, 'google_calendar_access_token', 'fake-access')", [seed.userId])

  const cal = await import('@/lib/calendar')
  writeStudyBlocksToCalendar = cal.writeStudyBlocksToCalendar
  const time = await import('@/lib/time')
  startOfLocalDayUtc = time.startOfLocalDayUtc
  dateKeyInTimeZone = time.dateKeyInTimeZone
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await db.query("delete from calendar_connections where user_id=$1 and provider='google'", [seed.userId])
  await db.query("delete from vault.secrets where name like '%' || $1 || '%' and name like '%google%'", [seed.userId]).catch(() => {})
  await db.end()
})

beforeEach(() => { created = []; listedBeforeCreate = false })

function installGoogleMock(busy: { start: string; end: string }[]) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
    const u = String(url)
    if (!u.includes('googleapis.com')) return realFetch(url as string, opts) // DB/vault → real
    const method = opts?.method ?? 'GET'
    if (u.includes('/freeBusy')) return json({ calendars: { primary: { busy } } })
    if (u.includes('/users/me/calendarList')) return json({ items: [{ id: 'primary' }] })
    if (u.includes('/events') && method === 'POST') {
      const ev = JSON.parse(String(opts!.body))
      created.push({ summary: ev.summary, start: ev.start.dateTime, end: ev.end.dateTime })
      return json({ id: `evt-${created.length}` })
    }
    if (u.includes('/events') && method === 'GET') { // delete-existing list step
      if (created.length === 0) listedBeforeCreate = true
      return json({ items: [] })
    }
    return json({})
  }) as typeof fetch
}

describe('writeStudyBlocksToCalendar — live write path against mocked Google', () => {
  it('creates study events that AVOID an existing 10am–12pm commitment', async () => {
    const today = dateKeyInTimeZone(new Date(), tz)
    const midnight = startOfLocalDayUtc(today, tz).getTime()
    const busy = [{ start: new Date(midnight + 10 * H).toISOString(), end: new Date(midnight + 12 * H).toISOString() }]
    installGoogleMock(busy)

    await writeStudyBlocksToCalendar(seed.userId, [
      { course_name: 'Organic Chem', duration_minutes: 60, order: 1 },
      { course_name: 'Calculus', duration_minutes: 45, order: 2 },
    ])

    expect(created.length, 'events were actually created (adding works)').toBeGreaterThan(0)
    const bStart = midnight + 10 * H, bEnd = midnight + 12 * H
    for (const ev of created) {
      const s = new Date(ev.start).getTime(), e = new Date(ev.end).getTime()
      expect(s < bEnd && e > bStart, `"${ev.summary}" (${ev.start}→${ev.end}) overlaps the 10–12 commitment`).toBe(false)
      expect(ev.summary).toMatch(/^Study: /)
    }
    expect(listedBeforeCreate, 'stale Cogni blocks are cleared BEFORE new ones are added (no stacking)').toBe(true)
  })

  it('skips creation when the whole day is busy (no slot to add into)', async () => {
    const today = dateKeyInTimeZone(new Date(), tz)
    const midnight = startOfLocalDayUtc(today, tz).getTime()
    const busy = [{ start: new Date(midnight + 7 * H).toISOString(), end: new Date(midnight + 23 * H).toISOString() }]
    installGoogleMock(busy)
    await writeStudyBlocksToCalendar(seed.userId, [{ course_name: 'X', duration_minutes: 60, order: 1 }])
    expect(created.length, 'nothing scheduled into a fully-booked day').toBe(0)
  })
})
