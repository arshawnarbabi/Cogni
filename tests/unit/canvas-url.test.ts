import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '@/lib/canvas'

// H8 audit fix: the student-pasted Canvas base URL is fetched server-side —
// self-hosted deployments must not be steerable into internal networks.
describe('normalizeBaseUrl', () => {
  it('accepts real Canvas hosts', () => {
    expect(normalizeBaseUrl('https://umich.instructure.com')).toBe('https://umich.instructure.com')
    expect(normalizeBaseUrl('canvas.harvard.edu/courses')).toBe('https://canvas.harvard.edu')
  })
  it('forces https and strips port/path', () => {
    expect(normalizeBaseUrl('http://canvas.school.edu:8080/x')).toBe('https://canvas.school.edu')
  })
  it('rejects localhost, IP literals, and internal suffixes', () => {
    expect(normalizeBaseUrl('localhost')).toBeNull()
    expect(normalizeBaseUrl('http://127.0.0.1')).toBeNull()
    expect(normalizeBaseUrl('10.0.0.5')).toBeNull()
    expect(normalizeBaseUrl('169.254.169.254')).toBeNull()
    expect(normalizeBaseUrl('intranet.corp.local')).toBeNull()
    expect(normalizeBaseUrl('metadata.google.internal')).toBeNull()
    expect(normalizeBaseUrl('service.lan')).toBeNull()
  })
  it('rejects junk', () => {
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl('not a url')).toBeNull()
  })
})
