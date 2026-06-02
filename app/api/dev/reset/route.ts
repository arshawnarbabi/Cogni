import { createClient, createServiceClient } from '@/lib/supabase/server'
import { deleteUserApiKey, deleteUserSecret } from '@/lib/vault'
import { NextResponse } from 'next/server'

const STORAGE_PAGE = 1000

async function clearStorageBucket(service: ReturnType<typeof createServiceClient>, bucket: string, userId: string) {
  async function listAll(prefix: string): Promise<{ id?: string | null; name: string }[]> {
    const all: { id?: string | null; name: string }[] = []
    let offset = 0
    for (;;) {
      const { data } = await service.storage.from(bucket).list(prefix, { limit: STORAGE_PAGE, offset })
      if (!data?.length) break
      all.push(...data)
      if (data.length < STORAGE_PAGE) break
      offset += STORAGE_PAGE
    }
    return all
  }

  async function collect(prefix: string): Promise<string[]> {
    const files = await listAll(prefix)
    if (!files.length) return []
    const nested = await Promise.all(files.map(async (f) => {
      const path = `${prefix}/${f.name}`
      return f.id ? [path] : collect(path)
    }))
    return nested.flat()
  }

  for (const prefix of [userId, `${userId}/syllabuses`]) {
    const paths = await collect(prefix)
    if (paths.length) await service.storage.from(bucket).remove(paths)
  }
}

export async function POST() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Cascades to all tables (courses, topics, flashcards, materials, etc.)
  await service.from('users').delete().eq('user_id', user.id)
  // user_keys references auth.users(id), not public.users, so the public.users
  // delete above does NOT cascade to it. Remove it (and any legacy plaintext) directly.
  await service.from('user_keys').delete().eq('user_id', user.id)

  // Best-effort cleanup of storage objects and Vault secrets. The dev reset keeps
  // the user's auth.users row (Google sign-in) intact, so allow settling rather than
  // rejecting the whole batch when a single Vault/storage call fails.
  await Promise.allSettled([
    clearStorageBucket(service, 'wiki', user.id),
    clearStorageBucket(service, 'materials', user.id),
    clearStorageBucket(service, 'audio', user.id),
    clearStorageBucket(service, 'course-files', user.id),
    deleteUserApiKey(user.id),
    deleteUserSecret(user.id, 'openai_key'),
    deleteUserSecret(user.id, 'google_calendar_access_token'),
    deleteUserSecret(user.id, 'google_calendar_refresh_token'),
  ])

  return NextResponse.json({ ok: true })
}
