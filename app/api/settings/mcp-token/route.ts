import { createClient, createServiceClient } from '@/lib/supabase/server'
import { generateMcpToken } from '@/lib/mcp/auth'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Manage the signed-in user's Cogni MCP token (for connecting their own Claude).
//   GET    → is a token connected? (no plaintext — that's only shown once on create)
//   POST   → generate/rotate; returns the plaintext token ONCE
//   DELETE → revoke

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const { data } = await service
    .from('mcp_tokens')
    .select('created_at, last_used_at, expires_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    connected: !!data,
    created_at: data?.created_at ?? null,
    last_used_at: data?.last_used_at ?? null,
    expires_at: data?.expires_at ?? null,
  })
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const { token, hash } = generateMcpToken()
  // Tokens expire after 180 days (previously they lived forever — a leaked token
  // was valid indefinitely). Regenerating in Settings issues a fresh 180-day token.
  const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
  // One active token per user (user_id is the PK). Upsert ATOMICALLY replaces any
  // existing token in a single statement, so concurrent regenerates can't leave two
  // valid tokens — and the old token is revoked the instant the new one is written.
  const { error } = await service
    .from('mcp_tokens')
    .upsert(
      { user_id: user.id, token_hash: hash, label: 'claude', created_at: new Date().toISOString(), last_used_at: null, expires_at: expiresAt },
      { onConflict: 'user_id' },
    )
  if (error) {
    console.error('[mcp-token] upsert failed', error)
    return NextResponse.json({ error: 'Could not create token' }, { status: 500 })
  }

  // Plaintext returned ONCE; we only ever stored its hash.
  return NextResponse.json({ token })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  await service.from('mcp_tokens').delete().eq('user_id', user.id)
  return NextResponse.json({ ok: true })
}
