import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const seed = JSON.parse(readFileSync('test-harness/seed-output.json', 'utf8'))
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000) // audio TTS + scripting is slow

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('Flashcard agent generates cards for a topic (Haiku)', async ({ page }) => {
  const before = (await db.from('flashcards').select('*', { count: 'exact', head: true }).eq('topic_id', seed.topics.kinematics)).count ?? 0
  const res = await page.request.post('/api/flashcards/generate', {
    data: { courseId: seed.courseA, topicId: seed.topics.kinematics },
    timeout: 90_000,
  })
  expect(res.ok(), `flashcards HTTP ${res.status()}`).toBeTruthy()
  const after = (await db.from('flashcards').select('*', { count: 'exact', head: true }).eq('topic_id', seed.topics.kinematics)).count ?? 0
  expect(after, 'new flashcards were created').toBeGreaterThan(before)
})

test('Uploading a material generates real OpenAI embeddings (vector RAG path)', async ({ page }) => {
  const notes = 'Lecture 4 — Dynamics. A free body diagram isolates forces. Friction opposes relative motion. Tension acts along a rope. Normal force is perpendicular to the surface.'
  const res = await page.request.post('/api/inbox/upload', {
    multipart: { file: { name: 'dynamics-lecture.txt', mimeType: 'text/plain', buffer: Buffer.from(notes) } },
    timeout: 100_000,
  })
  expect(res.ok(), `upload HTTP ${res.status()}`).toBeTruthy()

  // newest material for this user = the one we just uploaded
  const { data: mats } = await db.from('materials').select('material_id').eq('user_id', seed.userId).order('uploaded_at', { ascending: false }).limit(1)
  const materialId = mats![0].material_id

  // processEmbeddings can finish slightly after the response — poll for a real vector
  let hasVector = false
  for (let i = 0; i < 12 && !hasVector; i++) {
    const { count } = await db.from('material_embeddings').select('*', { count: 'exact', head: true }).eq('material_id', materialId).not('embedding', 'is', null)
    if ((count ?? 0) > 0) hasVector = true
    else await sleep(1500)
  }
  expect(hasVector, 'a non-null OpenAI embedding vector was stored').toBe(true)
})

test('Audio overview generates a podcast file (Sonnet script + OpenAI TTS)', async ({ page }) => {
  const before = (await db.storage.from('audio').list(seed.userId)).data?.length ?? 0
  const res = await page.request.post('/api/agents/audio-overview', {
    data: { courseId: seed.courseA },
    timeout: 160_000,
  })
  expect(res.ok(), `audio-overview HTTP ${res.status()}`).toBeTruthy()
  const { data: files } = await db.storage.from('audio').list(seed.userId)
  const mp3s = (files ?? []).filter(f => f.name.endsWith('.mp3') && f.name.startsWith(`${seed.courseA}_`))
  expect(mp3s.length, 'an mp3 audio overview was written to storage').toBeGreaterThan(0)
  expect((files ?? []).length).toBeGreaterThanOrEqual(before)
})
