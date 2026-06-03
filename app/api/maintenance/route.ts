import { createServiceClient } from '@/lib/supabase/server'
import { isValidCronRequest } from '@/lib/cron'
import { pingHeartbeat } from '@/lib/heartbeat'
import { NextResponse } from 'next/server'

export const maxDuration = 60

// Weekly maintenance cron (vercel.json: 0 4 * * 0). Prunes the daily_usage abuse
// counter so it doesn't grow unbounded. Authenticated by CRON_SECRET like the
// other crons.
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const service = createServiceClient()
    const { data, error } = await service.rpc('purge_old_daily_usage')
    if (error) {
      console.error('[maintenance] purge_old_daily_usage failed', error)
      await pingHeartbeat(process.env.CRON_HEARTBEAT_MAINTENANCE_URL, false)
      return NextResponse.json({ ok: false }, { status: 500 })
    }
    await pingHeartbeat(process.env.CRON_HEARTBEAT_MAINTENANCE_URL, true)
    return NextResponse.json({ ok: true, purgedDailyUsageRows: data ?? 0 })
  } catch (e) {
    console.error('[maintenance] failed', e)
    await pingHeartbeat(process.env.CRON_HEARTBEAT_MAINTENANCE_URL, false)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
