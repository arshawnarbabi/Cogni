import { createClient, createServiceClient } from '@/lib/supabase/server'
import { listUserSessions } from '@/lib/agents/tutor'
import { requireOwnedSession } from '@/lib/authz'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessions = await listUserSessions(user.id)
  return NextResponse.json({ sessions })
}

export async function PATCH(request: Request) {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { essay_content } = await request.json() as { essay_content: string }
  const session = await requireOwnedSession(user.id, sessionId)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const service = createServiceClient()
  const { error } = await service
    .from('session_log')
    .update({ essay_content, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership before deleting
  const session = await requireOwnedSession(user.id, sessionId)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // session_messages cascade via FK
  const service = createServiceClient()
  const { error } = await service.from('session_log').delete().eq('session_id', sessionId).eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
