import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setUserSecret } from '@/lib/vault'
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

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  await Promise.all([
    clearStorageBucket(service, 'wiki', user.id),
    clearStorageBucket(service, 'materials', user.id),
    clearStorageBucket(service, 'audio', user.id),
    clearStorageBucket(service, 'course-files', user.id),
    service.rpc('store_user_api_key', { p_user_id: user.id, p_key: '' }),
    setUserSecret(user.id, 'openai_key', ''),
    setUserSecret(user.id, 'google_calendar_access_token', ''),
    setUserSecret(user.id, 'google_calendar_refresh_token', ''),
  ])

  const { error } = await service.from('users').delete().eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabase.auth.signOut()

  return NextResponse.json({ ok: true })
}
