import { createClient, createServiceClient } from '@/lib/supabase/server'
import { listUserSessions } from '@/lib/agents/tutor'
import { requireOwnedSession } from '@/lib/authz'
import { serverError, readJson, badRequest } from '@/lib/api-error'
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

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{ essay_content: unknown }>(request)
  if (!body) return badRequest('invalid_json')
  const { essay_content } = body

  // essay_content is persisted free text that's re-downloaded with every session
  // list — bound it like the wiki route (400 non-string, 413 over 200k chars)
  // instead of letting the text column reject non-strings with a 500.
  if (typeof essay_content !== 'string') {
    return badRequest('invalid_essay_content')
  }
  if (essay_content.length > 200_000) {
    return NextResponse.json({ error: 'essay too large' }, { status: 413 })
  }

  const session = await requireOwnedSession(user.id, sessionId)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const service = createServiceClient()
  const { error } = await service
    .from('session_log')
    .update({ essay_content, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('user_id', user.id)

  if (error) return serverError('tutor/sessions:PATCH', error)
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
  if (error) return serverError('tutor/sessions:DELETE', error)

  return NextResponse.json({ ok: true })
}
