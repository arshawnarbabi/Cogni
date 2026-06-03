import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

export const dynamic = 'force-dynamic'

// Minimal operator console (no UI) for incident response:
//   GET  /api/operator        → recent audit log + currently-suspended users
//   POST /api/operator        → { userId, suspended, reason } suspend/unsuspend
// Gated by the OPERATOR_SECRET env var (sent as `x-operator-secret` header).
// If OPERATOR_SECRET is unset, the endpoint is disabled (404) so it can never be
// left open by accident.

function authorized(request: Request): boolean {
  const secret = process.env.OPERATOR_SECRET
  if (!secret) return false
  const provided = request.headers.get('x-operator-secret') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!process.env.OPERATOR_SECRET) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const [audit, suspended] = await Promise.all([
    service.from('audit_log').select('id, created_at, actor, action, subject_user_id, detail').order('created_at', { ascending: false }).limit(100),
    service.from('users').select('user_id, display_name, suspended').eq('suspended', true).limit(200),
  ])
  return NextResponse.json({
    recentAudit: audit.data ?? [],
    suspendedUsers: suspended.data ?? [],
  })
}

export async function POST(request: Request) {
  if (!process.env.OPERATOR_SECRET) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { userId?: string; suspended?: boolean; reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  if (!body.userId || typeof body.suspended !== 'boolean') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const service = createServiceClient()
  // operator_set_suspended updates users.suspended AND writes an audit_log row atomically.
  const { error } = await service.rpc('operator_set_suspended', {
    p_user_id: body.userId,
    p_suspended: body.suspended,
    p_reason: body.reason ?? '',
  })
  if (error) {
    console.error('[operator] suspend failed', error)
    return NextResponse.json({ error: 'operation_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, userId: body.userId, suspended: body.suspended })
}
