import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

async function clearStorageBucket(service: ReturnType<typeof createServiceClient>, bucket: string, userId: string) {
  async function collect(prefix: string): Promise<string[]> {
    const { data: files } = await service.storage.from(bucket).list(prefix, { limit: 200 })
    if (!files?.length) return []
    const nested = await Promise.all(files.map(async (f: { id?: string | null; name: string }) => {
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

  await Promise.all([
    clearStorageBucket(service, 'wiki', user.id),
    clearStorageBucket(service, 'materials', user.id),
    clearStorageBucket(service, 'audio', user.id),
    clearStorageBucket(service, 'course-files', user.id),
  ])

  return NextResponse.json({ ok: true })
}
