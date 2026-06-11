import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'Calendar not configured' }, { status: 503 })

  // H10: `state` must be unguessable. The user id is NOT (it appears in export
  // filenames and storage paths) — a forged callback could bind an attacker's
  // Google account to a victim's row. A per-flow random nonce, echoed back by
  // Google and matched against this HttpOnly cookie, closes that.
  const nonce = randomBytes(32).toString('base64url')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    state: nonce,
  })

  const res = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  res.cookies.set('calendar_oauth_state', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // must survive the cross-site redirect back from Google
    maxAge: 600,
    path: '/api/calendar/callback',
  })
  return res
}
