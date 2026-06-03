import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from Server Component — cookies set in middleware instead
          }
        },
      },
    }
  )
}

// Service role client for server-side agent operations (bypasses RLS).
// Uses require() so the client is typed as any, which matches how the rest of
// the codebase treats Supabase join results (untyped, shape-cast at the call
// site). Switching to the typed ESM import would propagate generic inference
// through every agent file. Safe to revisit once the join-cast patterns are
// replaced with generated database types.
//
// Memoized at module scope: the service client holds no per-user state
// (persistSession: false) and is safe to reuse across requests within a warm
// serverless instance, avoiding a fresh client construction on every call.
let serviceClient: ReturnType<typeof buildServiceClient> | null = null

function buildServiceClient() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export function createServiceClient() {
  if (!serviceClient) serviceClient = buildServiceClient()
  return serviceClient
}
