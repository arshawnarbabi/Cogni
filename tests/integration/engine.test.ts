// Layer 2 — behind-the-scenes engine tests against the LOCAL Supabase + seeded data.
// Run with: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. npx vitest run tests/integration
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env.SUPABASE_URL
const KEY_ = process.env.SUPABASE_SERVICE_ROLE_KEY
const seed = JSON.parse(readFileSync(fileURLToPath(new URL('../../test-harness/seed-output.json', import.meta.url)), 'utf8'))
const db = createClient(URL_!, KEY_!, { auth: { autoRefreshToken: false, persistSession: false } })

const masteryOf = async (topicId: string) => {
  const { data } = await db.from('topic_mastery').select('mastery_score').eq('user_id', seed.userId).eq('topic_id', topicId).maybeSingle()
  return data ? Number(data.mastery_score) : null
}
// The RPC scales the learning rate by 1/sqrt(cards in the topic) under its lock.
const deckScaledLr = async (topicId: string, baseLr: number) => {
  const { count } = await db.from('flashcards').select('*', { count: 'exact', head: true }).eq('user_id', seed.userId).eq('topic_id', topicId)
  return baseLr / Math.sqrt(Math.max(1, count ?? 1))
}
const historyCount = async (topicId: string) => {
  const { count } = await db.from('mastery_history').select('*', { count: 'exact', head: true }).eq('user_id', seed.userId).eq('topic_id', topicId)
  return count ?? 0
}

beforeAll(() => {
  if (!URL_ || !KEY_) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
})

describe('review_card_atomic RPC (evidence model, F3)', () => {
  it('updates FSRS, applies the EWMA evidence rule, and writes history (existing row)', async () => {
    const topic = seed.topics.kinematics
    // pin a known starting mastery
    await db.from('topic_mastery').update({ mastery_score: 0.5 }).eq('user_id', seed.userId).eq('topic_id', topic)
    const before = await historyCount(topic)

    const { error } = await db.rpc('review_card_atomic', {
      p_card_id: seed.cards[0], p_user_id: seed.userId,
      p_fsrs_stability: 12.3, p_fsrs_difficulty: 6.1, p_fsrs_reps: 99, p_fsrs_lapses: 1,
      p_fsrs_state: 'review', p_fsrs_last_review: new Date().toISOString(),
      p_fsrs_next_review_date: '2099-01-01', p_observed: 0.75, p_learning_rate: 0.2, p_rating: 3, p_client_review_id: crypto.randomUUID(),
    })
    expect(error).toBeNull()

    const { data: card } = await db.from('flashcards').select('fsrs_reps, fsrs_next_review_date, fsrs_state').eq('card_id', seed.cards[0]).single()
    expect(card!.fsrs_reps).toBe(99)
    expect(card!.fsrs_next_review_date).toBe('2099-01-01')

    // EWMA with the deck-scaled rate: 0.5 + lr/sqrt(deck) * (0.75 - 0.5).
    // precision 2: mastery_score is numeric(3,2) — the column itself rounds
    // to two decimals, so the stored value can differ from the float by ≤0.005.
    const lr = await deckScaledLr(topic, 0.2)
    expect(await masteryOf(topic)).toBeCloseTo(0.5 + lr * 0.25, 2)
    expect(await historyCount(topic)).toBe(before + 1)     // history written
  })

  it('CREATES a missing topic_mastery row, adopting the observed level (cold start)', async () => {
    const topic = seed.topics.kinematics
    await db.from('topic_mastery').delete().eq('user_id', seed.userId).eq('topic_id', topic)
    expect(await masteryOf(topic)).toBeNull() // gone

    const { error } = await db.rpc('review_card_atomic', {
      p_card_id: seed.cards[1], p_user_id: seed.userId,
      p_fsrs_stability: 1, p_fsrs_difficulty: 5, p_fsrs_reps: 1, p_fsrs_lapses: 0,
      p_fsrs_state: 'learning', p_fsrs_last_review: new Date().toISOString(),
      p_fsrs_next_review_date: '2099-02-02', p_observed: 0.75, p_learning_rate: 0.2, p_rating: 3, p_client_review_id: crypto.randomUUID(),
    })
    expect(error).toBeNull()
    expect(await masteryOf(topic)).toBeCloseTo(0.75, 5) // recreated at observed, not no-op
  })

  it('moves toward 1.0 without overshooting (EWMA converges asymptotically)', async () => {
    const topic = seed.topics.kinematics
    await db.from('topic_mastery').update({ mastery_score: 0.95 }).eq('user_id', seed.userId).eq('topic_id', topic)
    await db.rpc('review_card_atomic', {
      p_card_id: seed.cards[0], p_user_id: seed.userId,
      p_fsrs_stability: 1, p_fsrs_difficulty: 5, p_fsrs_reps: 2, p_fsrs_lapses: 0,
      p_fsrs_state: 'review', p_fsrs_last_review: new Date().toISOString(),
      p_fsrs_next_review_date: '2099-03-03', p_observed: 1.0, p_learning_rate: 0.25, p_rating: 4, p_client_review_id: crypto.randomUUID(),
    })
    // 0.95 + 0.25 * (1.0 - 0.95) = 0.9625
    const m = await masteryOf(topic)
    expect(m).toBeGreaterThan(0.95)
    expect(m).toBeLessThanOrEqual(1)
  })

  it('grows the confidence column with each evidence event (was always 0)', async () => {
    const topic = seed.topics.kinematics
    const { data: row } = await db.from('topic_mastery').select('confidence').eq('user_id', seed.userId).eq('topic_id', topic).single()
    expect(Number(row!.confidence)).toBeGreaterThan(0)
  })

  it('rejects a review for a card the user does not own', async () => {
    const { error } = await db.rpc('review_card_atomic', {
      p_card_id: seed.cards[0], p_user_id: '00000000-0000-0000-0000-000000000000',
      p_fsrs_stability: 1, p_fsrs_difficulty: 5, p_fsrs_reps: 1, p_fsrs_lapses: 0,
      p_fsrs_state: 'review', p_fsrs_last_review: new Date().toISOString(),
      p_fsrs_next_review_date: '2099-01-01', p_observed: 0.75, p_learning_rate: 0.2, p_rating: 3, p_client_review_id: crypto.randomUUID(),
    })
    expect(error).not.toBeNull() // "card not found or not owned by user"
  })

  it('applies a replayed client_review_id exactly ONCE (B6 idempotency)', async () => {
    const topic = seed.topics.kinematics
    await db.from('topic_mastery').upsert(
      { user_id: seed.userId, topic_id: topic, mastery_score: 0.5, confidence: 0 },
      { onConflict: 'user_id,topic_id' },
    )
    const before = await historyCount(topic)
    const reviewId = crypto.randomUUID()
    const params = {
      p_card_id: seed.cards[0], p_user_id: seed.userId,
      p_fsrs_stability: 2, p_fsrs_difficulty: 5, p_fsrs_reps: 3, p_fsrs_lapses: 0,
      p_fsrs_state: 'review', p_fsrs_last_review: new Date().toISOString(),
      p_fsrs_next_review_date: '2099-04-04', p_observed: 0.75, p_learning_rate: 0.2,
      p_rating: 3, p_client_review_id: reviewId,
    }

    const first = await db.rpc('review_card_atomic', params)
    expect(first.error).toBeNull()
    const masteryAfterFirst = await masteryOf(topic)

    // Replay: same client_review_id — must be a no-op, not a second application.
    const second = await db.rpc('review_card_atomic', params)
    expect(second.error).toBeNull()

    expect(await masteryOf(topic)).toBeCloseTo(masteryAfterFirst!, 5) // unchanged
    expect(await historyCount(topic)).toBe(before + 1)                // exactly one history row
    const { count: logCount } = await db.from('review_logs')
      .select('*', { count: 'exact', head: true })
      .eq('client_review_id', reviewId)
    expect(logCount).toBe(1)                                          // exactly one log row
  })
})

describe('Vault secret RPCs (incl. the new delete)', () => {
  it('stores, retrieves, then permanently deletes a per-user secret', async () => {
    const name = 'openai_key'
    await db.rpc('store_user_secret', { p_user_id: seed.userId, p_secret_name: name, p_secret: 'sk-test-abc123' })
    const { data: got } = await db.rpc('get_user_secret', { p_user_id: seed.userId, p_secret_name: name })
    expect(got).toBe('sk-test-abc123')

    await db.rpc('delete_user_secret', { p_user_id: seed.userId, p_secret_name: name })
    const { data: after } = await db.rpc('get_user_secret', { p_user_id: seed.userId, p_secret_name: name })
    expect(after).toBeNull() // truly removed, not blanked
  })
})

describe('RAG keyword fallback (GIN full-text index + english config)', () => {
  it('returns the seeded chunk matching a keyword query', async () => {
    const { data, error } = await db
      .from('material_embeddings')
      .select('material_id, chunk_index, content')
      .eq('user_id', seed.userId)
      .in('material_id', [seed.materialId])
      .textSearch('content', 'Newton', { type: 'plain', config: 'english' })
      .limit(5)
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some(r => /Newton/i.test(r.content))).toBe(true)
  })
})
