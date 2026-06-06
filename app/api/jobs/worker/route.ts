import { isValidCronRequest } from '@/lib/cron'
import { processJobs } from '@/lib/jobs'
import { NextResponse } from 'next/server'

// Manual/external drain of the durable job queue (F1). Jobs normally drain
// post-response via kickJobs() and are swept by the daily scheduler cron; this
// endpoint exists for ops (drain on demand) or an external scheduler hitting it
// more frequently than Vercel Hobby's daily cron allows.
//   GET /api/jobs/worker   (Authorization: Bearer $CRON_SECRET)
export const maxDuration = 300

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await processJobs(25, 5)
  return NextResponse.json({ ok: true, ...result })
}
