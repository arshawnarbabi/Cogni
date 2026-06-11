// ─────────────────────────────────────────────────────────────────────────────
// Canvas LMS client (S5) — student personal-access-token integration.
//
// Built to the documented API contract (canvas.instructure.com/doc/api):
//  - Auth: `Authorization: Bearer <token>` on every request (never query param —
//    tokens in query strings are stripped from pagination Link headers).
//  - Pagination: follow Link header rel="next" (opaque absolute URLs) until
//    absent; per_page=100; never rely on rel="last" existing.
//  - Requests are SERIALIZED per token — Canvas's leaky-bucket throttle docs:
//    "any API client that makes no more than one simultaneous request is
//    unlikely to be throttled".
//  - 401 + WWW-Authenticate header = invalid/expired token (re-prompt user);
//    403 with "Rate Limit Exceeded" body = throttled (backoff + retry once).
//  - Grade math branches on the course's apply_assignment_group_weights flag:
//    true → assignment-group weights ARE the grading scheme; false → pure
//    points (group_weight is meaningless and must be ignored).
//  - Skip: unpublished assignments, omit_from_final_grade, excused submissions,
//    and scores with posted_at=null (grade still hidden/muted by the teacher).
// ─────────────────────────────────────────────────────────────────────────────

export class CanvasAuthError extends Error {
  constructor() { super('canvas_invalid_token') }
}
export class CanvasRateLimitError extends Error {
  constructor() { super('canvas_rate_limited') }
}

/** Normalize a student-pasted Canvas URL to `https://<host>` or null if junk. */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    const host = u.hostname.toLowerCase()
    // The regex already rejects IP literals + dotless names (localhost); also
    // reject internal-network suffixes so a self-hosted Cogni inside a private
    // network can't be steered into fetching intranet services (H8) — Canvas
    // instances live on public DNS.
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) return null
    if (/\.(local|localhost|internal|intranet|lan|home|corp)$/.test(host)) return null
    return `https://${host}`
  } catch {
    return null
  }
}

/** Extract the rel="next" URL from a Canvas Link header (opaque — use verbatim). */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  const m = /<([^>]+)>;\s*rel="next"/.exec(linkHeader)
  return m ? m[1] : null
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function canvasGet(url: string, token: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  if (res.status === 401 && res.headers.get('www-authenticate') !== null) {
    throw new CanvasAuthError()
  }
  if (res.status === 403) {
    const body = await res.clone().text().catch(() => '')
    if (/rate limit exceeded/i.test(body)) {
      if (attempt < 3) {
        await sleep(1500 * attempt)
        return canvasGet(url, token, attempt + 1)
      }
      throw new CanvasRateLimitError()
    }
  }
  return res
}

/** Fetch every page of a paginated Canvas collection — sequentially. */
export async function canvasFetchAll<T>(startUrl: string, token: string, maxPages = 20): Promise<T[]> {
  const out: T[] = []
  let url: string | null = startUrl
  let pages = 0
  while (url && pages < maxPages) {
    const res: Response = await canvasGet(url, token)
    if (!res.ok) {
      // Per-resource 404s (unpublished/date-restricted courses) are the
      // caller's problem to skip; anything else non-OK stops this collection.
      throw new Error(`canvas_http_${res.status}`)
    }
    const batch = (await res.json()) as T[]
    out.push(...batch)
    url = parseNextLink(res.headers.get('link'))
    pages++
  }
  return out
}

// ── Response shapes (exact Canvas field names) ───────────────────────────────

export type CanvasCourse = {
  id: number
  name?: string
  course_code?: string
  workflow_state?: string
  apply_assignment_group_weights?: boolean
  access_restricted_by_date?: boolean
  enrollments?: { type?: string; computed_current_score?: number | null; computed_current_grade?: string | null }[] | null
  term?: { name?: string } | null
}

export type CanvasSubmission = {
  score: number | null
  graded_at: string | null
  workflow_state?: string
  excused?: boolean | null
  posted_at?: string | null
}

export type CanvasAssignment = {
  id: number
  name?: string
  due_at: string | null
  points_possible: number | null
  published?: boolean
  omit_from_final_grade?: boolean
  submission?: CanvasSubmission | null
}

export type CanvasAssignmentGroup = {
  id: number
  name?: string
  group_weight?: number | null
  assignments?: CanvasAssignment[]
}

// ── API calls ────────────────────────────────────────────────────────────────

/** The student's active courses, with their current enrollment grade inline. */
export async function listCanvasCourses(baseUrl: string, token: string): Promise<CanvasCourse[]> {
  const url = `${baseUrl}/api/v1/courses?enrollment_state=active&enrollment_type=student&include[]=total_scores&include[]=term&per_page=100`
  const courses = await canvasFetchAll<CanvasCourse>(url, token)
  // Date-restricted course stubs have no usable data.
  return courses.filter(c => !c.access_restricted_by_date && c.id)
}

/** Groups (the grading scheme when weighted) + assignments + the student's own
 *  submissions for one course — a single paginated endpoint. */
export async function getCourseGradeData(baseUrl: string, token: string, canvasCourseId: string | number): Promise<CanvasAssignmentGroup[]> {
  const url = `${baseUrl}/api/v1/courses/${canvasCourseId}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`
  return canvasFetchAll<CanvasAssignmentGroup>(url, token)
}

// ── Pure mapping (unit-tested) ───────────────────────────────────────────────

export type MappedImport = {
  /** Grading scheme — ONLY when the course applies group weights. */
  scheme: { category: string; weight_pct: number }[]
  /** Graded work → grade_items rows. */
  gradeItems: {
    external_id: string
    name: string
    category: string | null
    points_earned: number
    points_possible: number
    graded_at: string | null
  }[]
  /** Future-dated assignments → Cogni assignments (due-date planning). */
  upcomingAssignments: { external_id: string; name: string; due_date: string }[]
}

export function mapCanvasCourseData(
  groups: CanvasAssignmentGroup[],
  applyGroupWeights: boolean,
  nowIso: string,
): MappedImport {
  const scheme = applyGroupWeights
    ? groups
        .filter(g => typeof g.group_weight === 'number' && (g.group_weight as number) > 0)
        .map(g => ({ category: (g.name ?? 'Other').trim().slice(0, 80), weight_pct: Math.round((g.group_weight as number) * 100) / 100 }))
    : []

  const gradeItems: MappedImport['gradeItems'] = []
  const upcomingAssignments: MappedImport['upcomingAssignments'] = []

  for (const g of groups) {
    const category = applyGroupWeights ? (g.name ?? 'Other').trim().slice(0, 80) : null
    for (const a of g.assignments ?? []) {
      if (a.published === false) continue
      const name = (a.name ?? 'Assignment').trim().slice(0, 200)

      // Graded → grade item. Skip excused, unposted (muted) grades, and
      // omit_from_final_grade items; require real points_possible.
      const sub = a.submission
      const graded =
        sub != null &&
        sub.score !== null &&
        sub.excused !== true &&
        sub.posted_at != null &&
        a.omit_from_final_grade !== true &&
        typeof a.points_possible === 'number' &&
        a.points_possible > 0
      if (graded) {
        gradeItems.push({
          external_id: String(a.id),
          name,
          category,
          points_earned: sub!.score as number,
          points_possible: a.points_possible as number,
          graded_at: sub!.graded_at,
        })
      }

      // Future-dated → planner assignment. due_at is UTC ISO8601 or null.
      // Skip work the student already turned in (submitted/graded/pending
      // review) or was excused from — "upcoming homework" means TO DO, and a
      // graded-early assignment imported as pending would nag forever.
      const alreadyHandled =
        sub?.excused === true ||
        (sub?.workflow_state != null && ['submitted', 'graded', 'pending_review'].includes(sub.workflow_state))
      if (a.due_at && a.due_at > nowIso && !alreadyHandled) {
        upcomingAssignments.push({
          external_id: String(a.id),
          name,
          due_date: a.due_at.split('T')[0],
        })
      }
    }
  }

  return { scheme, gradeItems, upcomingAssignments }
}
