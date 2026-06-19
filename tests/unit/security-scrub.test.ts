import { describe, it, expect } from 'vitest'
import { icsEscape } from '@/app/api/calendar/feed/[token]/route'
import { scrubUrl, scrubEvent } from '@/lib/sentry-scrub'

// H14: ICS property/event injection — a hostile assignment/course name (from AI
// syllabus extraction or Canvas import) carrying a bare CR could split content
// lines in lenient parsers and inject calendar properties/events.
describe('icsEscape (H14)', () => {
  it('escapes the RFC 5545 specials', () => {
    expect(icsEscape('a;b,c\\d')).toBe('a\\;b\\,c\\\\d')
  })
  it('neutralizes a BARE carriage return (the bug)', () => {
    const out = icsEscape('Midterm\rATTENDEE:mailto:evil@x.com')
    expect(out).not.toContain('\r')
    expect(out).toBe('Midterm\\nATTENDEE:mailto:evil@x.com')
  })
  it('neutralizes CRLF and bare LF too', () => {
    expect(icsEscape('a\r\nb\nc\rd')).toBe('a\\nb\\nc\\nd')
    expect(icsEscape('x\r\ny')).not.toMatch(/[\r\n]/)
  })
})

// H13: the calendar feed token rides in the URL path; an uncaught error in that
// route must not persist the live token in Sentry.
describe('Sentry scrubbing (H13)', () => {
  it('replaces the entire feed-token segment with [token]', () => {
    // The whole final path segment (token + any .ics extension) is the secret,
    // so the scrub consumes all of it.
    expect(scrubUrl('https://app/api/calendar/feed/abc-123-secret.ics'))
      .toBe('https://app/api/calendar/feed/[token]')
    expect(scrubUrl('https://app/api/calendar/feed/550e8400-e29b-41d4-a716-446655440000?x=1'))
      .toBe('https://app/api/calendar/feed/[token]?x=1')
  })
  it('leaves unrelated URLs untouched', () => {
    expect(scrubUrl('https://app/api/grades?courseId=x')).toBe('https://app/api/grades?courseId=x')
  })
  it('scrubs both request.url and transaction on an event', () => {
    const ev = scrubEvent({
      request: { url: 'https://app/api/calendar/feed/tok123' },
      transaction: 'GET /api/calendar/feed/tok123',
    })
    expect(ev.request!.url).toContain('[token]')
    expect(ev.request!.url).not.toContain('tok123')
    expect(ev.transaction).toContain('[token]')
  })
  it('is a no-op on events without URLs', () => {
    expect(scrubEvent({})).toEqual({})
  })
})
