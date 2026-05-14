import { createServiceClient } from '@/lib/supabase/server'

const SECRET_NAME_RE = /^[a-z0-9_]+$/

export async function getUserApiKey(userId: string): Promise<string | null> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('get_user_api_key', { p_user_id: userId })
  if (error) {
    console.error('[vault] get_user_api_key RPC error:', error)
    return null
  }
  if (!data) {
    console.error(`[vault] get_user_api_key returned empty for user ${userId} (secret name should be "api_key_${userId}")`)
    return null
  }
  return data as string
}

export async function getUserSecret(userId: string, secretName: string): Promise<string | null> {
  if (!SECRET_NAME_RE.test(secretName)) return null
  const service = createServiceClient()
  const { data, error } = await service.rpc('get_user_secret', {
    p_user_id: userId,
    p_secret_name: secretName,
  })
  if (error) {
    console.error('[vault] get_user_secret RPC error:', error)
    return null
  }
  return data ? data as string : null
}

export async function setUserSecret(userId: string, secretName: string, value: string): Promise<void> {
  if (!SECRET_NAME_RE.test(secretName)) throw new Error('Invalid secret name')
  const service = createServiceClient()
  const { error } = await service.rpc('store_user_secret', {
    p_user_id: userId,
    p_secret_name: secretName,
    p_secret: value,
  })
  if (error) throw new Error(error.message)
}
