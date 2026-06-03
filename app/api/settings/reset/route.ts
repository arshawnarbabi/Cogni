import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const STORAGE_PAGE = 1000

async function clearBucket(service: ReturnType<typeof createServiceClient>, bucket: string, userId: string) {
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Reset content only. The UI promises the account row and API keys are kept,
  // so we must NOT delete public.users (which would cascade the whole profile).
  // Deleting courses cascades topics, topic_mastery, flashcards, exams,
  // assignments, session_log/messages, nudges and mastery_history via course FKs.
  await service.from('courses').delete().eq('user_id', user.id)
  // materials.course_id is ON DELETE SET NULL (not cascade), so materials survive
  // a course delete. Remove them directly — this cascades material_embeddings and
  // inbox_items (material_id FK). Then sweep the remaining direct-of-users tables.
  await service.from('materials').delete().eq('user_id', user.id)
  await service.from('inbox_items').delete().eq('user_id', user.id)
  await service.from('professors').delete().eq('user_id', user.id)
  await service.from('wiki_versions').delete().eq('user_id', user.id)
  await service.from('study_plan').delete().eq('user_id', user.id)
  // Reset streak/study fields on the preserved users row.
  await service.from('users').update({ study_streak: 0, last_study_date: null }).eq('user_id', user.id)

  // Clear all storage buckets (paginated + recursive into nested course folders).
  await Promise.all([
    clearBucket(service, 'wiki', user.id),
    clearBucket(service, 'materials', user.id),
    clearBucket(service, 'audio', user.id),
    clearBucket(service, 'course-files', user.id),
  ])

  return NextResponse.json({ ok: true })
}
