import { createServiceClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'
import { getUserSecret, setUserSecret, deleteUserSecret } from '@/lib/vault'

// Every vault-backed per-user secret that flows through this module. Missing
// entries fail closed (get → null, set → throw), which silently disabled the
// whole Canvas integration when 'canvas_token' wasn't listed.
const ALLOWED_KEYS = new Set(['openai_key', 'canvas_token'])

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
  const legacy = data?.key_value ?? null

  // Eager migration: a legacy plaintext row should not sit in an ordinary table
  // (visible in DB dumps/backups) until the user happens to re-save it. Move it
  // into the Vault on first read and drop the plaintext copy. Best-effort: on
  // vault failure the row stays and we just return the value as before.
  if (legacy) {
    try {
      await setUserSecret(userId, keyName, legacy)
      await service.from('user_keys').delete().eq('user_id', userId).eq('key_name', keyName)
    } catch (e) {
      console.error('[user-keys] legacy->vault migration failed', e)
    }
  }
  return legacy
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
