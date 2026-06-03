import { createClient } from '@/lib/supabase/server'
import { getUserKey, setUserKey, deleteUserKey } from '@/lib/user-keys'
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

  try {
    await setUserKey(user.id, key, value.trim())
  } catch (e) {
    console.error('[user/keys] setUserKey failed:', e)
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }
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
