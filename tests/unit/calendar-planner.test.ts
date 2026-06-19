import { describe, it, expect } from 'vitest'
import { findFreeSlots, planStudyBlocks } from '@/lib/calendar'

// Proves the calendar IS smart: study blocks are planned into the gaps BETWEEN
// the student's existing calendar events (read live from Google freeBusy),
// sized from the scheduler's duration, spaced with breaks, in priority order —
// never overlapping a real commitment. All times here are minutes-as-ms from a
// notional 8:00am day start so the math is easy to read.
const H = 60 * 60_000          // one hour in ms
const at = (h: number) => h * H // hours after the 8am window start, in ms
const DAY_START = 0            // 8:00am
const DAY_END = at(14)        // 10:00pm (14h window)
const mins = (ms: number) => ms / 60_000

describe('findFreeSlots — gaps around busy windows', () => {
  it('returns the gaps before/after a single busy block', () => {
    const busy = [{ start: at(2), end: at(4) }] // 10am–12pm class
    const free = findFreeSlots(busy, DAY_START, DAY_END, 15)
    expect(free).toEqual([{ start: 0, end: at(2) }, { start: at(4), end: at(14) }])
  })
  it('drops gaps shorter than the minimum', () => {
    // back-to-back busy 9:00–9:50 and 10:00–11:00 leaves only a 10-min gap → dropped at min 15
    const busy = [{ start: at(1), end: at(1) + 50 * 60_000 }, { start: at(2), end: at(3) }]
    const free = findFreeSlots(busy, DAY_START, DAY_END, 15)
    expect(free.some(f => f.start === at(1) + 50 * 60_000)).toBe(false)
  })
  it('whole day free when there are no events', () => {
    expect(findFreeSlots([], DAY_START, DAY_END, 15)).toEqual([{ start: 0, end: at(14) }])
  })
})

describe('planStudyBlocks — conflict-aware placement', () => {
  it('never overlaps a busy window', () => {
    const busy = [{ start: at(2), end: at(4) }] // 10am–12pm
    const plan = planStudyBlocks(busy, DAY_START, DAY_END, [
      { course_name: 'Chem', duration_minutes: 90, order: 1 },
      { course_name: 'Math', duration_minutes: 45, order: 2 },
    ])
    expect(plan.length).toBe(2)
    for (const b of plan) {
      const overlaps = b.start < at(4) && b.end > at(2)
      expect(overlaps, `${b.course_name} ${mins(b.start)}–${mins(b.end)} overlaps the 10–12 class`).toBe(false)
    }
  })

  it('leaves a 10-minute break between consecutive blocks', () => {
    const plan = planStudyBlocks([], DAY_START, DAY_END, [
      { course_name: 'A', duration_minutes: 30, order: 1 },
      { course_name: 'B', duration_minutes: 30, order: 2 },
    ])
    expect(mins(plan[1].start - plan[0].end)).toBe(10)
  })

  it('respects priority order (lower order is scheduled earlier)', () => {
    const plan = planStudyBlocks([], DAY_START, DAY_END, [
      { course_name: 'Low', duration_minutes: 30, order: 5 },
      { course_name: 'High', duration_minutes: 30, order: 1 },
    ])
    expect(plan[0].course_name).toBe('High')
    expect(plan[0].start).toBeLessThan(plan[1].start)
  })

  it('skips a block that does not fit any remaining free slot (overflow is dropped, not crammed)', () => {
    // Only a 1-hour morning gap before an all-day-ish busy block; a 90-min task can't fit.
    const busy = [{ start: at(1), end: at(14) }] // busy 9am–10pm, only 8–9 free
    const plan = planStudyBlocks(busy, DAY_START, DAY_END, [
      { course_name: 'Fits', duration_minutes: 45, order: 1 },
      { course_name: 'TooBig', duration_minutes: 90, order: 2 },
    ])
    expect(plan.map(b => b.course_name)).toEqual(['Fits'])
  })

  it('places blocks inside a real free gap between two classes', () => {
    const busy = [{ start: at(1), end: at(3) }, { start: at(5), end: at(7) }] // 9–11 and 1–3
    const plan = planStudyBlocks(busy, DAY_START, DAY_END, [
      { course_name: 'Gap', duration_minutes: 60, order: 1 },
    ])
    // the 11am–1pm gap (or the 8–9 morning) — must be a valid free window, never inside a class
    const b = plan[0]
    const inBusy = (busy as { start: number; end: number }[]).some(w => b.start < w.end && b.end > w.start)
    expect(inBusy).toBe(false)
  })

  it('returns nothing when the day is fully booked', () => {
    expect(planStudyBlocks([{ start: 0, end: at(14) }], DAY_START, DAY_END, [
      { course_name: 'X', duration_minutes: 30, order: 1 },
    ])).toEqual([])
  })
})
