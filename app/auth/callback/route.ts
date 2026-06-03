import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { LEGAL_VERSION } from '@/lib/legal'
import { auditLog } from '@/lib/app-config'

// Records consent for users who arrive via OAuth (they accept the clickwrap
// notice on the auth page rather than the email-signup form). Best-effort and
// idempotent: only stamps the audit columns the first time they're empty.
async function recordConsentIfNew(userId: string) {
  try {
    const service = createServiceClient()
    const { data } = await service.from('users').select('tos_accepted_at').eq('user_id', userId).maybeSingle()
    if (data?.tos_accepted_at) return
    const now = new Date().toISOString()
    await service.from('users').upsert(
      { user_id: userId, tos_version: LEGAL_VERSION, tos_accepted_at: now, privacy_version: LEGAL_VERSION, age_attested_at: now },
      { onConflict: 'user_id' },
    )
    await auditLog('signup', { subjectUserId: userId, detail: { mode: 'oauth' } })
  } catch (e) {
    console.error('[auth/callback] recordConsent failed', e)
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
      if (data.user) await recordConsentIfNew(data.user.id)
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/auth?error=callback_error`)
}
