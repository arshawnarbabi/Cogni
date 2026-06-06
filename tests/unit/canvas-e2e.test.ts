// E2E of lib/canvas.ts against a faithful mock Canvas server (node:http) —
// the founder has no Canvas account to test with, so the mock implements the
// documented contract verbatim: Bearer auth (401 + WWW-Authenticate on a bad
// token), Link-header rel="next" pagination, leaky-bucket throttling (403
// "Rate Limit Exceeded" body), weighted vs points courses, and muted grades.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { listCanvasCourses, getCourseGradeData, mapCanvasCourseData, canvasFetchAll, CanvasAuthError } from '@/lib/canvas'

const TOKEN = 'mock-canvas-token-abc123'
let base = ''
let server: http.Server
let rateLimitHits = 0
const seenAuthHeaders: (string | null)[] = []

// ── The mock Canvas ──────────────────────────────────────────────────────────
const COURSES_P1 = [
  { id: 101, name: 'Calculus II', course_code: 'MATH 2B', workflow_state: 'available', apply_assignment_group_weights: true, term: { name: 'Fall 2026' }, enrollments: [{ type: 'student', computed_current_score: 87.5 }] },
  { id: 102, name: 'Intro Psychology', course_code: 'PSY 101', workflow_state: 'available', apply_assignment_group_weights: false, term: { name: 'Fall 2026' }, enrollments: [{ type: 'student', computed_current_score: 92.1 }] },
]
const COURSES_P2 = [
  { id: 103, name: 'Restricted Course', access_restricted_by_date: true },
  { id: 104, name: 'Organic Chemistry', course_code: 'CHEM 51A', workflow_state: 'available', apply_assignment_group_weights: true, term: { name: 'Fall 2026' }, enrollments: [{ type: 'student', computed_current_score: null }] },
]

const CALC_GROUPS = [
  {
    id: 1, name: 'Exams', group_weight: 60,
    assignments: [
      { id: 9001, name: 'Midterm 1', due_at: '2026-10-10T06:59:00Z', points_possible: 100, published: true, submission: { score: 84, graded_at: '2026-10-14T12:00:00Z', posted_at: '2026-10-14T12:00:00Z', workflow_state: 'graded' } },
      { id: 9002, name: 'Final Exam', due_at: '2026-12-12T07:59:00Z', points_possible: 150, published: true, submission: { score: null, graded_at: null, posted_at: null, workflow_state: 'unsubmitted' } },
    ],
  },
  {
    id: 2, name: 'Problem Sets', group_weight: 40,
    assignments: [
      { id: 9003, name: 'PS1', due_at: '2026-09-20T06:59:00Z', points_possible: 20, published: true, submission: { score: 19, graded_at: '2026-09-22T12:00:00Z', posted_at: '2026-09-22T12:00:00Z', workflow_state: 'graded' } },
      // graded but MUTED — teacher hasn't released it
      { id: 9004, name: 'PS2', due_at: '2026-09-27T06:59:00Z', points_possible: 20, published: true, submission: { score: 17, graded_at: '2026-09-29T12:00:00Z', posted_at: null, workflow_state: 'graded' } },
      // excused
      { id: 9005, name: 'PS3', due_at: '2026-10-04T06:59:00Z', points_possible: 20, published: true, submission: { score: null, graded_at: null, excused: true, posted_at: null } },
    ],
  },
]

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://localhost')
    seenAuthHeaders.push(req.headers.authorization ?? null)

    // Auth exactly like Canvas: 401 + WWW-Authenticate on a bad/missing token.
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(res, 401, { errors: [{ message: 'Invalid access token.' }] }, { 'WWW-Authenticate': 'Bearer realm="canvas-lms"' })
    }

    if (url.pathname === '/api/v1/courses') {
      // Two pages via Link header (page 2 URL is opaque, as documented).
      if (url.searchParams.get('page') === '2') {
        return send(res, 200, COURSES_P2, { Link: `<${base}/api/v1/courses?page=2>; rel="current"` })
      }
      return send(res, 200, COURSES_P1, {
        Link: `<${base}/api/v1/courses?page=1>; rel="current", <${base}/api/v1/courses?page=2&per_page=100&enrollment_state=active>; rel="next"`,
      })
    }

    if (url.pathname === '/api/v1/courses/101/assignment_groups') {
      return send(res, 200, CALC_GROUPS)
    }

    if (url.pathname === '/api/v1/courses/429/assignment_groups') {
      // Throttle the first TWO hits (Canvas-style 403 + body), then succeed —
      // exercises the documented backoff-and-retry path.
      rateLimitHits++
      if (rateLimitHits <= 2) return send(res, 403, 'Rate Limit Exceeded')
      return send(res, 200, [{ id: 7, name: 'Only Group', group_weight: 100, assignments: [] }])
    }

    if (url.pathname === '/api/v1/courses/404/assignment_groups') {
      return send(res, 404, { errors: [{ message: 'The specified resource does not exist.' }] })
    }

    send(res, 404, { errors: [{ message: 'The specified resource does not exist.' }] })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => server.close())

describe('Canvas client E2E against a contract-faithful mock (S5)', () => {
  it('lists courses across pages (Link rel=next), sends Bearer auth, drops restricted stubs', async () => {
    const courses = await listCanvasCourses(base, TOKEN)
    // 4 returned across 2 pages, restricted one dropped
    expect(courses.map(c => c.id)).toEqual([101, 102, 104])
    expect(seenAuthHeaders.every(h => h === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('rejects a bad token with CanvasAuthError (401 + WWW-Authenticate)', async () => {
    await expect(listCanvasCourses(base, 'wrong-token')).rejects.toBeInstanceOf(CanvasAuthError)
  })

  it('full grade pipeline: fetch groups → map → scheme + released grades + planner items', async () => {
    const groups = await getCourseGradeData(base, TOKEN, 101)
    const mapped = mapCanvasCourseData(groups, true, '2026-09-25T00:00:00Z')

    expect(mapped.scheme).toEqual([
      { category: 'Exams', weight_pct: 60 },
      { category: 'Problem Sets', weight_pct: 40 },
    ])
    // Only the RELEASED grades: Midterm 1 + PS1. Muted PS2 and excused PS3 skipped.
    expect(mapped.gradeItems.map(g => g.external_id).sort()).toEqual(['9001', '9003'])
    // Planner gets only work still TO DO: the Final (future-dated, unsubmitted).
    // Midterm 1 (graded), PS2 (submitted+graded, grade merely hidden), and PS3
    // (excused) must NOT come back as pending homework.
    expect(mapped.upcomingAssignments.map(a => a.external_id)).toEqual(['9002'])
    expect(mapped.upcomingAssignments[0].due_date).toBe('2026-12-12')
  })

  it('backs off and retries through Canvas-style rate limiting (403 + body)', async () => {
    rateLimitHits = 0
    const groups = await canvasFetchAll<{ id: number }>(`${base}/api/v1/courses/429/assignment_groups`, TOKEN)
    expect(groups).toHaveLength(1)
    expect(rateLimitHits).toBe(3) // throttled twice, succeeded on the third
  }, 15000)

  it('surfaces per-course 404s as typed errors the import loop can skip', async () => {
    await expect(canvasFetchAll(`${base}/api/v1/courses/404/assignment_groups`, TOKEN)).rejects.toThrow('canvas_http_404')
  })
})
