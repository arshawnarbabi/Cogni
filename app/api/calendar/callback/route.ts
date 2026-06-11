import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setUserSecret } from '@/lib/vault'
import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code || !state) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?calendar=error`)
  }

  // H10: `state` is a per-flow random nonce set by /connect in an HttpOnly
  // cookie — only the browser that STARTED the flow can complete it, so a
  // forged callback URL (attacker's auth code, victim's session) is rejected.
  // The session check below still binds the link to the signed-in user.
  const stateCookie = request.cookies.get('calendar_oauth_state')?.value ?? ''
  const a = Buffer.from(state)
  const b = Buffer.from(stateCookie)
  if (!stateCookie || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?calendar=error`)
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?calendar=error`)
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET!,
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/callback`,
      code,
      grant_type: 'authorization_code',
    }),
  })

  if (!res.ok) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?calendar=error`)
  }

  const tokens = await res.json()
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  const service = createServiceClient()
  await setUserSecret(user.id, 'google_calendar_access_token', tokens.access_token)
  if (tokens.refresh_token) {
    await setUserSecret(user.id, 'google_calendar_refresh_token', tokens.refresh_token)
  }

  await service.from('calendar_connections').upsert({
    user_id: user.id,
    provider: 'google',
    access_token: '',
    refresh_token: null,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' })

  // Redirect back to onboarding if the user hasn't completed it yet (no users row)
  const { data: userRow } = await service.from('users').select('user_id').eq('user_id', user.id).maybeSingle()
  const returnPath = userRow ? '/settings?calendar=connected' : '/onboarding?calendar=connected'
  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}${returnPath}`)
}
