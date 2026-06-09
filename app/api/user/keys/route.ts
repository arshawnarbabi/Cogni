import { createClient } from '@/lib/supabase/server'
import { getUserKey, setUserKey, deleteUserKey } from '@/lib/user-keys'
import { markKeyStatus } from '@/lib/ai/call'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const keyName = searchParams.get('key')
  if (!keyName) return NextResponse.json({ error: 'Missing key param' }, { status: 400 })

  const value = await getUserKey(user.id, keyName)
  // Only return whether it exists + last 4 chars (never expose full key)
  return NextResponse.json({
    set: !!value,
    preview: value ? `••••${value.slice(-4)}` : null,
  })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key, value } = await request.json() as { key: string; value: string }
  if (!key || !value?.trim()) return NextResponse.json({ error: 'Missing key or value' }, { status: 400 })
  if (key !== 'openai_key') return NextResponse.json({ error: 'Unsupported key' }, { status: 400 })

  // Validate against OpenAI BEFORE storing (R5): models.list is free and 401s
  // on a bad key — a dead key stored silently breaks search/embeddings later.
  try {
    const { default: OpenAI } = await import('openai')
    const probe = new OpenAI({ apiKey: value.trim() })
    await probe.models.list()
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: 'That OpenAI key was rejected by OpenAI. Check that you copied the full key (it should start with sk-).' }, { status: 400 })
    }
    // Log ONLY the status — the SDK error object can carry request headers
    // (Authorization: Bearer <key>), so it must never reach the logs.
    console.warn(`[user/keys] OpenAI validation probe inconclusive (status ${status ?? 'n/a'}), storing anyway`)
  }

  try {
    await setUserKey(user.id, key, value.trim())
  } catch (e) {
    console.error('[user/keys] setUserKey failed:', e)
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }

  // A freshly-validated key is healthy — clear any stale 'invalid' banner.
  markKeyStatus(user.id, 'openai', 'ok')

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await request.json() as { key: string }
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  if (key !== 'openai_key') return NextResponse.json({ error: 'Unsupported key' }, { status: 400 })

  try {
    await deleteUserKey(user.id, key)
  } catch (e) {
    console.error('[user/keys] deleteUserKey failed:', e)
    return NextResponse.json({ error: 'Failed to delete key.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
