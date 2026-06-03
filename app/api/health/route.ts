import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Public health/readiness probe for uptime monitors (Healthchecks.io / Better
// Stack / UptimeRobot). Reveals only up/down — no user data, no counts.
export async function GET() {
  try {
    const service = createServiceClient()
    const { error } = await service.from('users').select('user_id').limit(1)
    if (error) return NextResponse.json({ status: 'degraded', db: false }, { status: 503 })
    return NextResponse.json({ status: 'ok', db: true })
  } catch {
    return NextResponse.json({ status: 'down' }, { status: 503 })
  }
}
