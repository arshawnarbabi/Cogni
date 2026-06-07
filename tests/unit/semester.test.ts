import { describe, it, expect } from 'vitest'
import { courseVerdict } from '@/lib/semester'

const base = { gradeAtRisk: false, gradeSunk: false, nearExamReadiness: null, overdueCount: 0, reviews14d: 10 }

describe('courseVerdict (semester standing, S15)', () => {
  it('healthy course is on track', () => {
    expect(courseVerdict({ ...base })).toBe('on_track')
    expect(courseVerdict({ ...base, nearExamReadiness: 75 })).toBe('on_track')
  })

  it('critical: the B is gone', () => {
    expect(courseVerdict({ ...base, gradeSunk: true, gradeAtRisk: true })).toBe('critical')
  })

  it('critical: grade at risk + badly unprepared near exam', () => {
    expect(courseVerdict({ ...base, gradeAtRisk: true, nearExamReadiness: 45 })).toBe('critical')
  })

  it('critical: grade at risk + 3 overdue assignments', () => {
    expect(courseVerdict({ ...base, gradeAtRisk: true, overdueCount: 3 })).toBe('critical')
  })

  it('at risk: any single alarm', () => {
    expect(courseVerdict({ ...base, gradeAtRisk: true })).toBe('at_risk')
    expect(courseVerdict({ ...base, nearExamReadiness: 55 })).toBe('at_risk')
    expect(courseVerdict({ ...base, overdueCount: 3 })).toBe('at_risk')
    expect(courseVerdict({ ...base, nearExamReadiness: 70, reviews14d: 0 })).toBe('at_risk')
  })

  it('grade at risk + decently-prepared exam stays at_risk, not critical', () => {
    expect(courseVerdict({ ...base, gradeAtRisk: true, nearExamReadiness: 65 })).toBe('at_risk')
  })

  it('idle fortnight alone (no near exam) is NOT an alarm', () => {
    expect(courseVerdict({ ...base, reviews14d: 0 })).toBe('on_track')
  })
})
