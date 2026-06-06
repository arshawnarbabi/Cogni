import { createServiceClient } from '@/lib/supabase/server'

// Usage & cost transparency (C7). BYOK = the student pays; recording every
// model call lets Settings show "your tutor cost $0.40 this week, caching
// saved you 60%" instead of leaving them blind (the #1 churn reason for a
// cost-conscious student). Fire-and-forget — never blocks the AI path.

export type UsageNumbers = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function recordUsage(userId: string, surface: string, model: string, usage: UsageNumbers): void {
  const service = createServiceClient()
  void service.from('usage_events').insert({
    user_id: userId,
    surface,
    model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
  }).then(() => {}, (e: unknown) => console.error('[usage] record failed', e))
}

// Static price map (USD per million tokens). Estimates for the Settings panel —
// good enough to make spend legible; exact billing is the provider's invoice.
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}
const DEFAULT_PRICE = PRICES['claude-sonnet-4-6']

export function estimateCostUsd(row: {
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}): number {
  const p = PRICES[row.model ?? ''] ?? DEFAULT_PRICE
  return (
    (row.input_tokens / 1e6) * p.in +
    (row.output_tokens / 1e6) * p.out +
    (row.cache_read_tokens / 1e6) * p.cacheRead +
    (row.cache_write_tokens / 1e6) * p.cacheWrite
  )
}

/** What the cache-read tokens WOULD have cost at full input price, minus what
 *  they actually cost — the "caching saved you $X" number. */
export function estimateCacheSavingsUsd(row: { model: string | null; cache_read_tokens: number }): number {
  const p = PRICES[row.model ?? ''] ?? DEFAULT_PRICE
  return (row.cache_read_tokens / 1e6) * (p.in - p.cacheRead)
}
