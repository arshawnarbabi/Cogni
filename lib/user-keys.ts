import { createServiceClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'
import { getUserSecret, setUserSecret, deleteUserSecret } from '@/lib/vault'

const ALLOWED_KEYS = new Set(['openai_key'])

export async function getUserKey(userId: string, keyName: string): Promise<string | null> {
  if (!ALLOWED_KEYS.has(keyName)) return null
  const vaultValue = await getUserSecret(userId, keyName)
  if (vaultValue) return vaultValue

  const service = createServiceClient()
  const { data } = await service
    .from('user_keys')
    .select('key_value')
    .eq('user_id', userId)
    .eq('key_name', keyName)
    .single()
  return data?.key_value ?? null
}

export async function setUserKey(userId: string, keyName: string, value: string): Promise<void> {
  if (!ALLOWED_KEYS.has(keyName)) throw new Error('Unsupported key')
  await setUserSecret(userId, keyName, value)

  const service = createServiceClient()
  await service.from('user_keys').delete().eq('user_id', userId).eq('key_name', keyName)
}

export async function deleteUserKey(userId: string, keyName: string): Promise<void> {
  if (!ALLOWED_KEYS.has(keyName)) return
  await deleteUserSecret(userId, keyName)

  const service = createServiceClient()
  await service.from('user_keys').delete().eq('user_id', userId).eq('key_name', keyName)
}

/** Convenience: get the authed user's key (for use in server components / route handlers) */
export async function getMyKey(keyName: string): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  return getUserKey(user.id, keyName)
}
