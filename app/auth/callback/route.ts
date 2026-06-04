import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { auditLog } from '@/lib/app-config'

// Best-effort signup audit for users who arrive via OAuth (they accept the
// clickwrap notice on the auth page). Their accepted consent versions are mirrored
// into the users.* columns later, at onboarding/complete — the public.users row
// does not exist yet here. A users row exists only after onboarding, so its absence
// marks a not-yet-onboarded (effectively new) account; we record the signup event
// once for that state.
async function recordOAuthSignup(userId: string) {
  try {
    const service = createServiceClient()
    const { data } = await service.from('users').select('user_id').eq('user_id', userId).maybeSingle()
    if (data) return
    await auditLog('signup', { subjectUserId: userId, detail: { mode: 'oauth' } })
  } catch (e) {
    console.error('[auth/callback] recordOAuthSignup failed', e)
  }
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/'
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      if (data.user) await recordOAuthSignup(data.user.id)
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/auth?error=callback_error`)
}
