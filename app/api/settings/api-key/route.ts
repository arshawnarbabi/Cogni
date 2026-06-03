import { createClient, createServiceClient } from '@/lib/supabase/server'
import { deleteUserApiKey } from '@/lib/vault'
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

  const service = createServiceClient()
  const { error } = await service.rpc('store_user_api_key', {
    p_user_id: user.id,
    p_key: key,
  })

  if (error) {
    console.error('Vault store error:', error)
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
