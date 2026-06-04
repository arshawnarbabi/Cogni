import { describe, it, expect } from 'vitest'
import {
  dateKeyInTimeZone,
  addDaysToDateKey,
  daysBetweenDateKeys,
  isValidTimeZone,
  zonedWallTimeToUtc,
  startOfLocalDayUtc,
  endOfLocalDayUtc,
  studyWindowUtc,
} from '@/lib/time'

const iso = (d: Date) => d.toISOString()

describe('dateKeyInTimeZone', () => {
  it('returns the local calendar date in the given zone', () => {
    // 15:30 UTC is 08:30 PDT (same day) in Los Angeles
    expect(dateKeyInTimeZone(new Date('2026-06-15T15:30:00Z'), 'America/Los_Angeles')).toBe('2026-06-15')
    // 05:00 UTC is 22:00 PDT the PREVIOUS day in Los Angeles
    expect(dateKeyInTimeZone(new Date('2026-06-15T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-06-14')
    // Ahead of UTC: 20:00 UTC is 01:30 next day in Kolkata (+5:30)
    expect(dateKeyInTimeZone(new Date('2026-06-15T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-06-16')
    // UTC passthrough
    expect(dateKeyInTimeZone(new Date('2026-06-15T23:59:00Z'), 'UTC')).toBe('2026-06-15')
  })
})

describe('addDaysToDateKey', () => {
  it('rolls over month and year boundaries', () => {
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToDateKey('2026-06-15', 6)).toBe('2026-06-21')
    expect(addDaysToDateKey('2026-06-15', 0)).toBe('2026-06-15')
  })
})

describe('daysBetweenDateKeys', () => {
  it('counts whole calendar days regardless of input format or order', () => {
    expect(daysBetweenDateKeys('2026-06-04', '2026-06-06')).toBe(2)
    expect(daysBetweenDateKeys('2026-06-06', '2026-06-04')).toBe(-2)
    expect(daysBetweenDateKeys('2026-06-15', '2026-06-15')).toBe(0)
    // month/year boundaries
    expect(daysBetweenDateKeys('2026-12-31', '2027-01-01')).toBe(1)
    // accepts a full ISO timestamp (uses the date portion only)
    expect(daysBetweenDateKeys('2026-06-04', '2026-06-11T00:00:00+00:00')).toBe(7)
  })
  it('is pure calendar arithmetic — no off-by-one for an exam "tomorrow"', () => {
    // Whatever the wall-clock instant, the day count between two local date keys is
    // stable (the bug we replaced used Date.now() ms math and could read 2 as 1).
    const today = dateKeyInTimeZone(new Date('2026-06-15T14:30:00Z'), 'Asia/Tokyo')
    const examTomorrow = addDaysToDateKey(today, 1)
    expect(daysBetweenDateKeys(today, examTomorrow)).toBe(1)
  })
})

describe('isValidTimeZone', () => {
  it('accepts valid IANA zones and rejects junk', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
  })
})

describe('zonedWallTimeToUtc', () => {
  it('converts a local wall-clock time to the correct UTC instant (DST + offsets)', () => {
    // PDT (UTC-7): 8am local -> 15:00Z
    expect(iso(zonedWallTimeToUtc('2026-06-15', 8, 0, 'America/Los_Angeles'))).toBe('2026-06-15T15:00:00.000Z')
    // PST (UTC-8): 8am local -> 16:00Z
    expect(iso(zonedWallTimeToUtc('2026-01-15', 8, 0, 'America/Los_Angeles'))).toBe('2026-01-15T16:00:00.000Z')
    // Kolkata (+5:30): 8am local -> 02:30Z
    expect(iso(zonedWallTimeToUtc('2026-06-15', 8, 0, 'Asia/Kolkata'))).toBe('2026-06-15T02:30:00.000Z')
    // US DST spring-forward day: 8am PDT still well-defined -> 15:00Z
    expect(iso(zonedWallTimeToUtc('2026-03-08', 8, 0, 'America/Los_Angeles'))).toBe('2026-03-08T15:00:00.000Z')
    // Auckland (+12 in NZ winter): 8am local -> prev day 20:00Z
    expect(iso(zonedWallTimeToUtc('2026-06-15', 8, 0, 'Pacific/Auckland'))).toBe('2026-06-14T20:00:00.000Z')
    // UTC passthrough
    expect(iso(zonedWallTimeToUtc('2026-06-15', 8, 0, 'UTC'))).toBe('2026-06-15T08:00:00.000Z')
  })
})

describe('startOfLocalDayUtc / endOfLocalDayUtc', () => {
  it('brackets the local day as UTC instants', () => {
    expect(iso(startOfLocalDayUtc('2026-06-15', 'America/Los_Angeles'))).toBe('2026-06-15T07:00:00.000Z')
    // end of day == next day's start
    expect(iso(endOfLocalDayUtc('2026-06-15', 'America/Los_Angeles'))).toBe('2026-06-16T07:00:00.000Z')
    expect(iso(startOfLocalDayUtc('2026-06-15', 'UTC'))).toBe('2026-06-15T00:00:00.000Z')
    expect(iso(endOfLocalDayUtc('2026-06-15', 'UTC'))).toBe('2026-06-16T00:00:00.000Z')
  })
  it('end is strictly after start and exactly 24h apart on a non-DST day', () => {
    const s = startOfLocalDayUtc('2026-06-15', 'America/Los_Angeles').getTime()
    const e = endOfLocalDayUtc('2026-06-15', 'America/Los_Angeles').getTime()
    expect(e).toBeGreaterThan(s)
    expect(e - s).toBe(24 * 60 * 60 * 1000)
  })
})

describe('studyWindowUtc', () => {
  it('produces the 8am-10pm local window as UTC instants', () => {
    const w = studyWindowUtc('2026-06-15', 'America/Los_Angeles')
    expect(iso(w.start)).toBe('2026-06-15T15:00:00.000Z') // 8am PDT
    expect(iso(w.end)).toBe('2026-06-16T05:00:00.000Z')   // 10pm PDT
    expect(w.end.getTime() - w.start.getTime()).toBe(14 * 60 * 60 * 1000)
  })
})
