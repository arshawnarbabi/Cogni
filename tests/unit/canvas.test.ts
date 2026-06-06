import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl, parseNextLink, mapCanvasCourseData, type CanvasAssignmentGroup } from '@/lib/canvas'

describe('normalizeBaseUrl (S5)', () => {
  it('accepts bare hosts, full URLs, and pasted paths', () => {
    expect(normalizeBaseUrl('school.instructure.com')).toBe('https://school.instructure.com')
    expect(normalizeBaseUrl('https://canvas.school.edu/')).toBe('https://canvas.school.edu')
    expect(normalizeBaseUrl('https://canvas.school.edu/courses/123')).toBe('https://canvas.school.edu')
    expect(normalizeBaseUrl('HTTP://School.Edu')).toBe('https://school.edu')
  })

  it('rejects junk', () => {
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl('not a url')).toBeNull()
    expect(normalizeBaseUrl('localhost')).toBeNull()
  })
})

describe('parseNextLink (Canvas pagination)', () => {
  it('extracts rel="next" from a real-shaped Link header', () => {
    const link = '<https://x.edu/api/v1/courses?page=1&per_page=100>; rel="current", <https://x.edu/api/v1/courses?page=2&per_page=100>; rel="next", <https://x.edu/api/v1/courses?page=1>; rel="first"'
    expect(parseNextLink(link)).toBe('https://x.edu/api/v1/courses?page=2&per_page=100')
  })

  it('returns null on the last page (no next) or missing header', () => {
    expect(parseNextLink('<https://x.edu/api/v1/courses?page=1>; rel="current", <https://x.edu/api/v1/courses?page=1>; rel="last"')).toBeNull()
    expect(parseNextLink(null)).toBeNull()
  })
})

const GROUPS: CanvasAssignmentGroup[] = [
  {
    id: 1, name: 'Exams', group_weight: 50,
    assignments: [
      { id: 101, name: 'Midterm 1', due_at: '2026-03-01T23:59:00Z', points_possible: 100, published: true, submission: { score: 84, graded_at: '2026-03-05T10:00:00Z', posted_at: '2026-03-05T10:00:00Z' } },
      { id: 102, name: 'Final', due_at: '2026-12-12T23:59:00Z', points_possible: 100, published: true, submission: { score: null, graded_at: null, posted_at: null } },
    ],
  },
  {
    id: 2, name: 'Homework', group_weight: 30,
    assignments: [
      { id: 201, name: 'HW1', due_at: '2026-02-01T23:59:00Z', points_possible: 20, published: true, submission: { score: 18, graded_at: '2026-02-03T00:00:00Z', posted_at: '2026-02-03T00:00:00Z' } },
      // excused — must NOT become a grade item
      { id: 202, name: 'HW2', due_at: '2026-02-08T23:59:00Z', points_possible: 20, published: true, submission: { score: 0, graded_at: '2026-02-09T00:00:00Z', excused: true, posted_at: '2026-02-09T00:00:00Z' } },
      // graded but MUTED (posted_at null) — grade not released, must be skipped
      { id: 203, name: 'HW3', due_at: '2026-02-15T23:59:00Z', points_possible: 20, published: true, submission: { score: 15, graded_at: '2026-02-16T00:00:00Z', posted_at: null } },
      // unpublished — invisible to the student, skip entirely
      { id: 204, name: 'Draft HW', due_at: null, points_possible: 20, published: false, submission: { score: 10, graded_at: '2026-02-16T00:00:00Z', posted_at: '2026-02-16T00:00:00Z' } },
      // omitted from final grade — skip as a grade item
      { id: 205, name: 'Practice (ungraded)', due_at: null, points_possible: 10, published: true, omit_from_final_grade: true, submission: { score: 9, graded_at: '2026-02-16T00:00:00Z', posted_at: '2026-02-16T00:00:00Z' } },
    ],
  },
  // zero-weight group: excluded from the scheme but its assignments still count
  { id: 3, name: 'Ungrouped', group_weight: 0, assignments: [] },
]

describe('mapCanvasCourseData (S5)', () => {
  const NOW = '2026-06-01T00:00:00Z'

  it('weighted course: groups become the grading scheme', () => {
    const m = mapCanvasCourseData(GROUPS, true, NOW)
    expect(m.scheme).toEqual([
      { category: 'Exams', weight_pct: 50 },
      { category: 'Homework', weight_pct: 30 },
    ])
  })

  it('points course: NO scheme, categories null (group_weight is meaningless)', () => {
    const m = mapCanvasCourseData(GROUPS, false, NOW)
    expect(m.scheme).toEqual([])
    expect(m.gradeItems.every(i => i.category === null)).toBe(true)
  })

  it('only real released grades become grade items (skips excused/muted/unpublished/omitted)', () => {
    const m = mapCanvasCourseData(GROUPS, true, NOW)
    expect(m.gradeItems.map(i => i.external_id).sort()).toEqual(['101', '201'])
    const midterm = m.gradeItems.find(i => i.external_id === '101')!
    expect(midterm.points_earned).toBe(84)
    expect(midterm.points_possible).toBe(100)
    expect(midterm.category).toBe('Exams')
  })

  it('future-dated assignments become planner entries (UTC date part)', () => {
    const m = mapCanvasCourseData(GROUPS, true, NOW)
    expect(m.upcomingAssignments).toEqual([
      { external_id: '102', name: 'Final', due_date: '2026-12-12' },
    ])
  })

  it('handles empty groups and null due_at without crashing', () => {
    const m = mapCanvasCourseData([{ id: 9, name: 'X', group_weight: null, assignments: [{ id: 1, name: 'a', due_at: null, points_possible: null, submission: null }] }], true, NOW)
    expect(m.gradeItems).toEqual([])
    expect(m.upcomingAssignments).toEqual([])
    expect(m.scheme).toEqual([])
  })
})
