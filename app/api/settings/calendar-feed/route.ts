import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import crypto from 'node:crypto'

export const dynamic = 'force-dynamic'

// ICS feed token management (S4).
//   GET    → current token (or null)
//   POST   → generate/rotate (rotating invalidates the old subscription URL)
//   DELETE → disable the feed

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const { data } = await service.from('users').select('calendar_feed_token').eq('user_id', user.id).maybeSingle()
  return NextResponse.json({ token: data?.calendar_feed_token ?? null })
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = crypto.randomUUID()
  const service = createServiceClient()
  const { error } = await service.from('users').update({ calendar_feed_token: token }).eq('user_id', user.id)
  if (error) return serverError('calendar-feed POST', error)
  return NextResponse.json({ token })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const { error } = await service.from('users').update({ calendar_feed_token: null }).eq('user_id', user.id)
  if (error) return serverError('calendar-feed DELETE', error)
  return NextResponse.json({ ok: true })
}
