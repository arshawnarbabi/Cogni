import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Next.js 16.2 middleware convention (the file/export are named `proxy`, which
// replaced `middleware`). Refreshes the Supabase session cookie and gates page
// navigation. API routes are intentionally EXCLUDED from the matcher: they
// authenticate themselves (getUser / CRON_SECRET). Matching /api here would
// redirect the unauthenticated cron GETs (scheduler/nudge) to /auth and turn
// API 401s into 307 redirects.
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getSession() reads from the cookie — no network call, no latency. This is a
  // redirect gate only; every protected page additionally calls getUser() server
  // side, so authorization never relies on the (unverified) cookie session here.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user

  const { pathname } = request.nextUrl
  // Public, unauthenticated routes: the auth flow (/auth covers /auth/callback)
  // and the legal pages. Signup consent links point at /legal/*, so they must be
  // reachable without a session.
  const publicRoutes = ['/auth', '/legal']
  const isPublicRoute = publicRoutes.some(route => pathname.startsWith(route))

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth'
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/auth') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Page routes only — exclude /api (self-authenticating + cron), Next internals,
    // and static assets.
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
