import { describe, it, expect } from 'vitest'
import { clampBlock, CONTEXT_BUDGETS } from '@/lib/agents/context-budget'

describe('clampBlock (context-budget governor, F2)', () => {
  it('passes short content through untouched', () => {
    expect(clampBlock('weak_topics', 'short list')).toBe('short list')
  })

  it('returns empty string for null/undefined', () => {
    expect(clampBlock('rag', null)).toBe('')
    expect(clampBlock('rag', undefined)).toBe('')
  })

  it('hard-caps oversized content and marks the truncation', () => {
    const huge = 'x'.repeat(CONTEXT_BUDGETS.course_memory * 3)
    const out = clampBlock('course_memory', huge)
    expect(out.length).toBeLessThanOrEqual(CONTEXT_BUDGETS.course_memory + 60)
    expect(out).toContain('[... trimmed to fit context budget ...]')
  })

  it('cuts at a line boundary when one exists in the back half', () => {
    const line = 'a'.repeat(200)
    const text = Array.from({ length: 100 }, () => line).join('\n')
    const out = clampBlock('professor', text)
    const body = out.replace('\n[... trimmed to fit context budget ...]', '')
    // every kept line is intact — no half-line cuts
    for (const l of body.split('\n')) expect(l).toBe(line)
  })

  it('every registered block has a sane budget', () => {
    for (const [, budget] of Object.entries(CONTEXT_BUDGETS)) {
      expect(budget).toBeGreaterThan(500)
      expect(budget).toBeLessThanOrEqual(24000)
    }
  })
})
