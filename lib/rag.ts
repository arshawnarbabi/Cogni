import { createServiceClient } from '@/lib/supabase/server'
import { getUserKey } from '@/lib/user-keys'

// ~800 tokens at 4 chars/token
const CHUNK_SIZE = 3200
const CHUNK_OVERLAP = 400

export type RetrievedChunk = {
  material_id: string
  chunk_index: number
  content: string
}

export function chunkText(text: string): { content: string; chunk_index: number }[] {
  const chunks: { content: string; chunk_index: number }[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length)

    if (end < text.length) {
      // Prefer splitting on paragraph break near the boundary
      const searchFrom = Math.max(start + CHUNK_SIZE - 600, start)
      const window = text.slice(searchFrom, end)
      const lastPara = window.lastIndexOf('\n\n')
      if (lastPara !== -1) {
        end = searchFrom + lastPara + 2
      } else {
        const lastSentence = window.lastIndexOf('. ')
        if (lastSentence !== -1) {
          end = searchFrom + lastSentence + 2
        }
      }
    }

    const chunk = text.slice(start, end).trim()
    if (chunk.length > 50) {
      chunks.push({ content: chunk, chunk_index: index++ })
    }

    const next = end - CHUNK_OVERLAP
    if (next <= start) break
    start = next
  }

  return chunks
}

export async function processEmbeddings(
  userId: string,
  materialId: string,
  text: string
): Promise<void> {
  const openaiKey = await getUserKey(userId, 'openai_key')
  const service = createServiceClient()

  const { data: material } = await service
    .from('materials')
    .select('material_id')
    .eq('material_id', materialId)
    .eq('user_id', userId)
    .single()
  if (!material) return

  const chunks = chunkText(text)
  if (chunks.length === 0) return

  // Replace existing embeddings for this material
  await service
    .from('material_embeddings')
    .delete()
    .eq('material_id', materialId)
    .eq('user_id', userId)

  if (openaiKey) {
    const { default: OpenAI } = await import('openai')
    const openai = new OpenAI({ apiKey: openaiKey })

    const batchSize = 100
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch.map(c => c.content),
      })

      await service.from('material_embeddings').insert(
        batch.map((chunk, j) => ({
          user_id: userId,
          material_id: materialId,
          chunk_index: chunk.chunk_index,
          content: chunk.content,
          embedding: response.data[j].embedding,
        }))
      )
    }
  } else {
    // No OpenAI key — store chunks without embeddings for keyword fallback
    await service.from('material_embeddings').insert(
      chunks.map(chunk => ({
        user_id: userId,
        material_id: materialId,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        embedding: null,
      }))
    )
  }
}

export async function retrieveChunks(
  query: string,
  courseId: string,
  userId: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  const openaiKey = await getUserKey(userId, 'openai_key')
  const service = createServiceClient()

  if (openaiKey) {
    const { default: OpenAI } = await import('openai')
    const openai = new OpenAI({ apiKey: openaiKey })

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query.slice(0, 2000),
    })
    const queryEmbedding = embeddingResponse.data[0].embedding

    const { data, error } = await service.rpc('match_material_chunks', {
      p_user_id: userId,
      p_course_id: courseId,
      p_query_embedding: queryEmbedding,
      p_top_k: topK,
    })

    if (error) {
      console.error('[rag] vector search failed, falling back to keyword', error)
      return keywordFallback(query, courseId, userId, topK)
    }

    return (data ?? []) as RetrievedChunk[]
  }

  return keywordFallback(query, courseId, userId, topK)
}

async function keywordFallback(
  query: string,
  courseId: string,
  userId: string,
  topK: number
): Promise<RetrievedChunk[]> {
  const service = createServiceClient()

  const { data: materials } = await service
    .from('materials')
    .select('material_id')
    .eq('course_id', courseId)
    .eq('user_id', userId)

  if (!materials || materials.length === 0) return []

  const ids = materials.map((m: { material_id: string }) => m.material_id)
  const searchQuery = query
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 8)
    .join(' ')

  if (!searchQuery) return []

  const { data } = await service
    .from('material_embeddings')
    .select('material_id, chunk_index, content')
    .eq('user_id', userId)
    .in('material_id', ids)
    .textSearch('content', searchQuery, { type: 'plain', config: 'english' })
    .limit(topK)

  return (data ?? []) as RetrievedChunk[]
}
