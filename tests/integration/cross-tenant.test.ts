// Locks in the Phase-0 security fixes: the previously-exposed SECURITY DEFINER
// RPCs (which trust a caller-supplied user_id) must NOT be callable via the
// public Data API with the anon key. Run alongside the engine tests, which prove
// the SAME functions still work via the service-role client (the app's path).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } })

describe('tenant isolation — exposed SECURITY DEFINER RPCs are locked down', () => {
  it('anon CANNOT decrypt a user API key via get_user_api_key', async () => {
    const { data, error } = await anon.rpc('get_user_api_key', { p_user_id: seed.userId })
    expect(error, 'should be permission-denied').not.toBeNull()
    expect(data).toBeNull()
  })

  it('anon CANNOT decrypt a named secret via get_user_secret', async () => {
    const { data, error } = await anon.rpc('get_user_secret', { p_user_id: seed.userId, p_secret_name: 'openai_key' })
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it("anon CANNOT rewrite another user's flashcard via review_card_atomic", async () => {
    const { error } = await anon.rpc('review_card_atomic', {
      p_card_id: seed.cards[0], p_user_id: seed.userId,
      p_fsrs_stability: 1, p_fsrs_difficulty: 1, p_fsrs_reps: 0, p_fsrs_lapses: 0,
      p_fsrs_state: 'review', p_fsrs_last_review: null, p_fsrs_next_review_date: '2099-01-01',
      p_observed: 0.75, p_learning_rate: 0.2, p_rating: 3, p_client_review_id: crypto.randomUUID(),
    })
    expect(error, 'should be permission-denied').not.toBeNull()
  })

  it('anon CANNOT store a secret via store_user_secret', async () => {
    const { error } = await anon.rpc('store_user_secret', { p_user_id: seed.userId, p_secret_name: 'openai_key', p_secret: 'hijacked' })
    expect(error).not.toBeNull()
  })
})
