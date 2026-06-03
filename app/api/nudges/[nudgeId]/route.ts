import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// PATCH { action: 'resolve' | 'snooze' }
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ nudgeId: string }> }
) {
  const { nudgeId } = await params
  const { action } = await request.json() as { action: 'resolve' | 'snooze' }

  if (!action || !['resolve', 'snooze'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Verify ownership
  const { data: nudge } = await service
    .from('nudges')
    .select('nudge_id, tier')
    .eq('nudge_id', nudgeId)
    .eq('user_id', user.id)
    .single()

  if (!nudge) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (action === 'resolve') {
    const { error } = await service.from('nudges').update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
    }).eq('nudge_id', nudgeId).eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await service.from('nudges').update({
      status: 'snoozed',
      snoozed_until: snoozedUntil,
    }).eq('nudge_id', nudgeId).eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
