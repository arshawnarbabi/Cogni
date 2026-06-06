import { createClient, createServiceClient } from '@/lib/supabase/server'
import { deleteUserApiKey } from '@/lib/vault'
import { markKeyStatus } from '@/lib/ai/call'
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Permanently remove the Anthropic key secret from the Vault (idempotent).
  // getUserApiKey() returns null when the secret is absent, so consumers' `if (!apiKey)` guards still hold.
  await deleteUserApiKey(user.id)

  return NextResponse.json({ ok: true })
}

export async function POST(request: Request) {
  const body = await request.json()
  const key: string = body?.key ?? ''

  if (!key || key.length < 20 || !key.startsWith('sk-')) {
    return NextResponse.json({ error: 'Invalid API key format.' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Validate the key against the provider BEFORE storing (R5): models.list is
  // free and fails 401 on a bad/revoked key. Previously a dead key was stored
  // silently and the user discovered it as a mysteriously broken app.
  try {
    const probe = new Anthropic({ apiKey: key })
    await probe.models.list({ limit: 1 })
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: 'That Anthropic key was rejected by Anthropic. Check that you copied the full key (it should start with sk-ant-).' }, { status: 400 })
    }
    // Provider hiccup (overloaded/network): don't block the save — the
    // circuit breaker will flag the key later if it's genuinely broken.
    console.warn('[api-key] validation probe inconclusive, storing anyway', e)
  }

  const service = createServiceClient()
  const { error } = await service.rpc('store_user_api_key', {
    p_user_id: user.id,
    p_key: key,
  })

  if (error) {
    console.error('Vault store error:', error)
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }

  // Read-back verification: confirm the key actually persisted (the vault store
  // has been observed to report success without persisting), so the user never
  // sees "saved" for a key that didn't save.
  const { data: persisted } = await service.rpc('get_user_api_key', { p_user_id: user.id })
  if (!persisted) {
    console.error('[api-key] store_user_api_key reported success but key did not persist')
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }

  // A freshly-validated key is healthy — clear any stale 'invalid' banner.
  markKeyStatus(user.id, 'anthropic', 'ok')

  return NextResponse.json({ ok: true })
}
