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

    // Growth hygiene for the big-update audit/telemetry tables (free-tier row
    // budget): usage_events 90d (the panel shows 30d), mcp_tool_calls 30d,
    // done/failed jobs 14d. review_logs is intentionally KEPT — it's the
    // substrate for per-user FSRS optimization.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const purges = await Promise.all([
      service.from('usage_events').delete().lt('created_at', ninetyDaysAgo),
      service.from('mcp_tool_calls').delete().lt('created_at', thirtyDaysAgo),
      service.from('jobs').delete().in('status', ['done', 'failed']).lt('updated_at', fourteenDaysAgo),
    ])
    purges.forEach((r, i) => {
      if (r.error) console.error(`[maintenance] purge ${['usage_events', 'mcp_tool_calls', 'jobs'][i]} failed`, r.error)
    })

    await pingHeartbeat(process.env.CRON_HEARTBEAT_MAINTENANCE_URL, true)
    return NextResponse.json({ ok: true, purgedDailyUsageRows: data ?? 0 })
  } catch (e) {
    console.error('[maintenance] failed', e)
    await pingHeartbeat(process.env.CRON_HEARTBEAT_MAINTENANCE_URL, false)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
