import { describe, it, expect } from 'vitest'
import { parseClassifyResponse } from '@/lib/agents/inbox'

// F1: the inbox classifier now also reads a grade off returned, graded work.
// A candidate is only accepted when is_graded AND both numbers are present.
describe('parseClassifyResponse — grade extraction (F1)', () => {
  const base = '"is_context_hint":false,"course_id":null,"tier":3,"is_homework":false,"due_date":null'

  it('extracts a valid score/total + name + category', () => {
    const r = parseClassifyResponse(`{${base},"is_graded":true,"points_earned":84,"points_possible":100,"assessment_name":"Midterm 1","category_guess":"Exams"}`)
    expect(r.grade).toEqual({ pointsEarned: 84, pointsPossible: 100, name: 'Midterm 1', categoryGuess: 'Exams' })
  })

  it('null when is_graded is false', () => {
    expect(parseClassifyResponse(`{${base},"is_graded":false,"points_earned":84,"points_possible":100}`).grade).toBeNull()
  })

  it('null when the total is missing (a "84/?" is too low-confidence)', () => {
    expect(parseClassifyResponse(`{${base},"is_graded":true,"points_earned":84,"points_possible":null}`).grade).toBeNull()
  })

  it('null when points_possible is 0 (avoid divide-by-zero downstream)', () => {
    expect(parseClassifyResponse(`{${base},"is_graded":true,"points_earned":0,"points_possible":0}`).grade).toBeNull()
  })

  it('accepts a 0 score with a real total', () => {
    expect(parseClassifyResponse(`{${base},"is_graded":true,"points_earned":0,"points_possible":50,"assessment_name":null,"category_guess":null}`).grade)
      .toEqual({ pointsEarned: 0, pointsPossible: 50, name: null, categoryGuess: null })
  })

  it('still parses the existing fields, and grade defaults to null', () => {
    const r = parseClassifyResponse(`{${base}}`)
    expect(r.tier).toBe(3)
    expect(r.grade).toBeNull()
  })

  it('malformed JSON → safe null grade', () => {
    expect(parseClassifyResponse('not json').grade).toBeNull()
  })
})
