import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Toggle whether the in-app Tutor tab routes to the user's own Claude (via MCP)
// instead of the built-in BYOK-API tutor.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { prefer_own_claude?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  if (typeof body.prefer_own_claude !== 'boolean') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const service = createServiceClient()
  const { error } = await service
    .from('users')
    .update({ prefer_own_claude: body.prefer_own_claude })
    .eq('user_id', user.id)
  if (error) {
    console.error('[tutor-mode] update failed', error)
    return NextResponse.json({ error: 'update_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, prefer_own_claude: body.prefer_own_claude })
}
