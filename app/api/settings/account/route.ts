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

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Best-effort cleanup of storage objects and Vault secrets. None of these must
  // be able to abort the critical account deletion below, so allow settling
  // (failures are swallowed) rather than rejecting the whole batch.
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

  // Delete the auth.users row so every ON DELETE CASCADE referencing auth.users(id)
  // fires: public.users (schema.sql), public.user_keys (user-keys.sql), and the
  // remaining direct auth.users children. This removes orphaned plaintext keys that
  // deleting only public.users would leave behind.
  const { error } = await service.auth.admin.deleteUser(user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabase.auth.signOut()

  return NextResponse.json({ ok: true })
}
