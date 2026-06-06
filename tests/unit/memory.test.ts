import { describe, it, expect } from 'vitest'
import { parseDistilled, DIGEST_CHAR_BUDGET } from '@/lib/agents/memory'

const VALID = {
  summary: 'Worked through the chain rule with several practice problems.',
  confusions: ['applies chain rule as if it were the product rule'],
  understood: ['basic derivative power rule'],
  preferences: ['wants worked examples before theory'],
  topic_names: ['The Chain Rule'],
  updated_digest: 'Student has covered limits and derivatives. Persistent confusion: chain vs product rule.',
}

describe('parseDistilled (memory distiller output, M1/M2)', () => {
  it('parses clean JSON', () => {
    const out = parseDistilled(JSON.stringify(VALID))
    expect(out).not.toBeNull()
    expect(out!.summary).toBe(VALID.summary)
    expect(out!.confusions).toEqual(VALID.confusions)
    expect(out!.updated_digest).toBe(VALID.updated_digest)
  })

  it('parses JSON wrapped in markdown fences', () => {
    const out = parseDistilled('```json\n' + JSON.stringify(VALID) + '\n```')
    expect(out).not.toBeNull()
    expect(out!.topic_names).toEqual(['The Chain Rule'])
  })

  it('parses JSON with leading prose (extracts the object)', () => {
    const out = parseDistilled('Here is the distillation:\n' + JSON.stringify(VALID))
    expect(out).not.toBeNull()
  })

  it('returns null on garbage / missing summary', () => {
    expect(parseDistilled('not json at all')).toBeNull()
    expect(parseDistilled('{"confusions": []}')).toBeNull()
    expect(parseDistilled('{"summary": "   "}')).toBeNull()
  })

  it('tolerates missing/malformed arrays (coerces to empty)', () => {
    const out = parseDistilled(JSON.stringify({ summary: 'ok', confusions: 'not-an-array' }))
    expect(out).not.toBeNull()
    expect(out!.confusions).toEqual([])
    expect(out!.updated_digest).toBe('')
  })

  it('caps the digest at the budget and each array at 8 entries', () => {
    const out = parseDistilled(JSON.stringify({
      summary: 'ok',
      confusions: Array.from({ length: 20 }, (_, i) => `c${i}`),
      updated_digest: 'y'.repeat(DIGEST_CHAR_BUDGET * 2),
    }))
    expect(out!.confusions.length).toBe(8)
    expect(out!.updated_digest.length).toBeLessThanOrEqual(DIGEST_CHAR_BUDGET)
  })
})
