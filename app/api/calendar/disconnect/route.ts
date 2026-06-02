import { createClient, createServiceClient } from '@/lib/supabase/server'
import { cleanupCogniCalendar } from '@/lib/calendar'
import { deleteUserSecret } from '@/lib/vault'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Delete the Cogni Study calendar from Google before removing credentials.
  // Best-effort — a failure here must not block the disconnect.
  await cleanupCogniCalendar(user.id).catch(e =>
    console.error('[calendar] cleanup on disconnect failed:', e)
  )

  const service = createServiceClient()
  const { error } = await service
    .from('calendar_connections')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', 'google')
  if (error) {
    console.error('[calendar] disconnect delete failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Only remove the Vault OAuth tokens after the row delete is confirmed.
  // Best-effort — a vault error must not leave the user unable to disconnect.
  await Promise.all([
    deleteUserSecret(user.id, 'google_calendar_access_token'),
    deleteUserSecret(user.id, 'google_calendar_refresh_token'),
  ]).catch(e => console.error('[calendar] vault cleanup failed:', e))

  return NextResponse.json({ ok: true })
}
