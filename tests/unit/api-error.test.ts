// Validation helpers backing the audit fixes: finiteNumber guards numeric API
// inputs (exam scores, tutor daily limit) and readJson makes malformed bodies a
// 400 instead of an unhandled 500. These are the pure trust-boundary checks —
// regressions here silently reopen the NaN/Infinity/garbage-body holes.
import { describe, it, expect } from 'vitest'
import { finiteNumber, readJson } from '@/lib/api-error'

describe('finiteNumber', () => {
  it('accepts in-range finite numbers', () => {
    expect(finiteNumber(0, { min: 0, max: 100 })).toBe(0)
    expect(finiteNumber(87.5, { min: 0, max: 100 })).toBe(87.5)
    expect(finiteNumber(100, { min: 0, max: 100 })).toBe(100)
    expect(finiteNumber(-3)).toBe(-3) // no opts → any finite number
  })

  it('rejects non-numbers (strings/booleans/objects/null/undefined)', () => {
    expect(finiteNumber('50')).toBeNull() // '5e1'-style strings must not coerce
    expect(finiteNumber(true)).toBeNull()
    expect(finiteNumber({})).toBeNull()
    expect(finiteNumber([])).toBeNull()
    expect(finiteNumber(null)).toBeNull()
    expect(finiteNumber(undefined)).toBeNull()
  })

  it('rejects NaN and Infinity (JSON 1e999 parses to Infinity)', () => {
    expect(finiteNumber(NaN)).toBeNull()
    expect(finiteNumber(Infinity, { min: 0, max: 100 })).toBeNull()
    expect(finiteNumber(-Infinity, { min: 0, max: 100 })).toBeNull()
  })

  it('enforces min/max range', () => {
    expect(finiteNumber(-0.01, { min: 0, max: 100 })).toBeNull()
    expect(finiteNumber(100.01, { min: 0, max: 100 })).toBeNull()
    expect(finiteNumber(501, { min: 1, max: 500, integer: true })).toBeNull() // tutor-limit ceiling
    expect(finiteNumber(500, { min: 1, max: 500, integer: true })).toBe(500)
  })

  it('enforces integer when requested', () => {
    expect(finiteNumber(2.5, { integer: true })).toBeNull()
    expect(finiteNumber(3, { integer: true })).toBe(3)
  })
})

describe('readJson', () => {
  const req = (body: string) =>
    new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

  it('parses a JSON object body', async () => {
    expect(await readJson<{ a: number }>(req('{"a":1}'))).toEqual({ a: 1 })
  })

  it('returns null for malformed JSON instead of throwing', async () => {
    expect(await readJson(req('{not json'))).toBeNull()
    expect(await readJson(req(''))).toBeNull()
  })

  it('returns null for non-object JSON (primitives/null)', async () => {
    expect(await readJson(req('null'))).toBeNull()
    expect(await readJson(req('42'))).toBeNull()
    expect(await readJson(req('"str"'))).toBeNull()
  })
})
