import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setUserSecret } from '@/lib/vault'
import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateUserId = url.searchParams.get('state')

  if (!code || !stateUserId) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?calendar=error`)
  }

  // Verify the OAuth `state` matches the caller's authenticated session.
  // Google redirects back into the user's browser with their Supabase cookie;
  // if `state` doesn't match the session we reject — this prevents an attacker
  // from forging a callback that links their Google account to someone else's user row.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.id !== stateUserId) {
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
