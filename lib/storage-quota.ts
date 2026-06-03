import { createServiceClient } from '@/lib/supabase/server'

// Per-user storage ceiling across all buckets. Protects a shared free-tier
// Supabase project (1 GB total) from any single user filling it. Tune as needed.
export const USER_STORAGE_LIMIT_BYTES = 250 * 1024 * 1024 // 250 MB

const BUCKETS = ['materials', 'audio', 'course-files', 'wiki']

type Service = ReturnType<typeof createServiceClient>

async function bucketBytes(service: Service, bucket: string, prefix: string): Promise<number> {
  let total = 0
  let offset = 0
  for (;;) {
    const { data } = await service.storage.from(bucket).list(prefix, { limit: 1000, offset })
    if (!data?.length) break
    for (const f of data as Array<{ id?: string | null; name: string; metadata?: { size?: number } }>) {
      if (f.id) total += f.metadata?.size ?? 0 // a file
      else total += await bucketBytes(service, bucket, `${prefix}/${f.name}`) // a folder (e.g. course-files/<courseId>/)
    }
    if (data.length < 1000) break
    offset += 1000
  }
  return total
}

/** Total bytes a user is storing across all buckets (objects live under `${userId}/...`). */
export async function userStorageBytes(userId: string): Promise<number> {
  const service = createServiceClient()
  let total = 0
  for (const b of BUCKETS) total += await bucketBytes(service, b, userId)
  return total
}

/** True if adding `incomingBytes` would push the user over the storage limit. */
export async function wouldExceedStorageLimit(userId: string, incomingBytes: number): Promise<boolean> {
  const used = await userStorageBytes(userId)
  return used + incomingBytes > USER_STORAGE_LIMIT_BYTES
}
