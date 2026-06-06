import { createClient, createServiceClient } from '@/lib/supabase/server'
import { estimateCostUsd, estimateCacheSavingsUsd } from '@/lib/usage'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Usage & cost summary for the Settings panel (C7): last-30-day spend by
// surface, total tokens, and what prompt caching saved.

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: events } = await service
    .from('usage_events')
    .select('surface, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens')
    .eq('user_id', user.id)
    .gte('created_at', thirtyDaysAgo)

  type Row = { surface: string; model: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
  const rows = (events ?? []) as Row[]

  const bySurface: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number }> = {}
  let totalCost = 0
  let cacheSavings = 0
  for (const r of rows) {
    const cost = estimateCostUsd(r)
    totalCost += cost
    cacheSavings += estimateCacheSavingsUsd(r)
    const s = (bySurface[r.surface] ??= { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 })
    s.calls += 1
    s.cost += cost
    s.inputTokens += r.input_tokens + r.cache_read_tokens + r.cache_write_tokens
    s.outputTokens += r.output_tokens
  }

  return NextResponse.json({
    days: 30,
    totalCostUsd: Math.round(totalCost * 100) / 100,
    cacheSavingsUsd: Math.round(cacheSavings * 100) / 100,
    bySurface: Object.entries(bySurface).map(([surface, v]) => ({
      surface,
      calls: v.calls,
      costUsd: Math.round(v.cost * 100) / 100,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
    })).sort((a, b) => b.costUsd - a.costUsd),
  })
}
