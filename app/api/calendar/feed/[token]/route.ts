import { createServiceClient } from '@/lib/supabase/server'
import { addDaysToDateKey, dateKeyInTimeZone, isValidTimeZone } from '@/lib/time'
import type { TaskItem } from '@/lib/agents/scheduler'

export const dynamic = 'force-dynamic'

// ICS subscription feed (S4): exams, assignment due dates, and upcoming study
// blocks as a read-only calendar ANY calendar app can subscribe to (Apple,
// Outlook, Google) — no OAuth, no write access to the student's calendar.
// The unguessable per-user token IS the auth (standard for ICS feeds; it's
// revocable by regenerating in Settings).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

// RFC 5545 §3.1: content lines longer than 75 octets MUST be folded
// (continuation lines start with a space). Fold on OCTET boundaries without
// splitting a multi-byte UTF-8 sequence — emoji summaries exceed the limit.
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts: Buffer[] = []
  let start = 0
  let limit = 75 // first line: 75 octets; continuations: space + 74
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    parts.push(bytes.subarray(start, end))
    start = end
    limit = 74
  }
  return parts.map((b, i) => (i === 0 ? '' : ' ') + b.toString('utf8')).join('\r\n')
}

function dateValue(dateKey: string): string {
  return dateKey.replace(/-/g, '')
}

function allDayEvent(uid: string, dateKey: string, summary: string, description?: string): string[] {
  // All-day VEVENT: DTEND is exclusive per RFC 5545.
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@cogni`,
    `DTSTAMP:${dateValue(dateKey)}T000000Z`,
    `DTSTART;VALUE=DATE:${dateValue(dateKey)}`,
    `DTEND;VALUE=DATE:${dateValue(addDaysToDateKey(dateKey, 1))}`,
    `SUMMARY:${icsEscape(summary)}`,
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    'END:VEVENT',
  ]
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const cleanToken = token.replace(/\.ics$/i, '')
  if (!UUID_RE.test(cleanToken)) {
    return new Response('Not found', { status: 404 })
  }

  const service = createServiceClient()
  const { data: user } = await service
    .from('users')
    .select('user_id, timezone')
    .eq('calendar_feed_token', cleanToken)
    .maybeSingle()
  if (!user) return new Response('Not found', { status: 404 })

  const tz = isValidTimeZone(user.timezone) ? user.timezone as string : 'UTC'
  const today = dateKeyInTimeZone(new Date(), tz)
  const horizon = addDaysToDateKey(today, 60)

  const [{ data: exams }, { data: assignments }, { data: plans }, { data: courses }] = await Promise.all([
    service.from('exams').select('exam_id, course_id, date, grade_weight').eq('user_id', user.user_id).gte('date', today).lte('date', horizon),
    service.from('assignments').select('assignment_id, course_id, name, due_date').eq('user_id', user.user_id).eq('completion_status', 'pending').gte('due_date', today).lte('due_date', horizon),
    service.from('study_plan').select('plan_date, tasks').eq('user_id', user.user_id).gte('plan_date', today).lte('plan_date', addDaysToDateKey(today, 7)),
    service.from('courses').select('course_id, name').eq('user_id', user.user_id),
  ])

  const courseName: Record<string, string> = {}
  for (const c of (courses ?? []) as { course_id: string; name: string }[]) courseName[c.course_id] = c.name

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cogni//Study Calendar//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Cogni — Study',
    'X-PUBLISHED-TTL:PT6H',
  ]

  for (const e of (exams ?? []) as { exam_id: string; course_id: string; date: string; grade_weight: number | null }[]) {
    const name = courseName[e.course_id] ?? 'Exam'
    const weight = e.grade_weight ? ` (${Math.round(Number(e.grade_weight))}% of grade)` : ''
    lines.push(...allDayEvent(`exam-${e.exam_id}`, e.date, `📝 ${name} exam${weight}`))
  }

  for (const a of (assignments ?? []) as { assignment_id: string; course_id: string; name: string | null; due_date: string }[]) {
    const dueKey = a.due_date.split('T')[0]
    const cname = courseName[a.course_id] ?? ''
    lines.push(...allDayEvent(`hw-${a.assignment_id}`, dueKey, `📚 Due: ${a.name ?? 'Assignment'}${cname ? ` — ${cname}` : ''}`))
  }

  for (const p of (plans ?? []) as { plan_date: string; tasks: TaskItem[] }[]) {
    const reviews = (p.tasks ?? []).filter((t): t is Extract<TaskItem, { type: 'flashcard_review' }> => t.type === 'flashcard_review')
    for (const r of reviews) {
      lines.push(...allDayEvent(
        `study-${p.plan_date}-${r.course_id}`,
        p.plan_date,
        `🧠 Study: ${r.course_name} (${r.duration_minutes} min, ${r.card_count} cards)`,
      ))
    }
  }

  lines.push('END:VCALENDAR')

  return new Response(lines.map(foldLine).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="cogni.ics"',
      'Cache-Control': 'private, max-age=900',
    },
  })
}
