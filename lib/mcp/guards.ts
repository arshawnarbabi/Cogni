import { createServiceClient } from '@/lib/supabase/server'
import { getAppConfig } from '@/lib/app-config'
import { isUserSuspended, consumeAiQuota } from '@/lib/rate-limit'

// Shared protective checks for every MCP tool handler (F4). The MCP server
// previously bypassed ALL of the in-app guards (verified bug B11): a suspended
// user — or any user during a global AI incident with the kill-switch flipped —
// could keep calling tools, and create_flashcards had no write budget at all
// (an unthrottled write surface on a long-lived token).
//
// Returns a user-facing error string, or null to proceed.
export async function mcpGuard(userId: string, kind: 'read' | 'write'): Promise<string | null> {
  if (await isUserSuspended(userId)) {
    return 'account_suspended: this Cogni account is suspended.'
  }

  // Kill-switch: fresh read on writes (must take effect immediately); the cached
  // config is fine for reads — they are frequent and harmless by comparison.
  const config = await getAppConfig(kind === 'write' ? { fresh: true } : undefined)
  if (config.aiDisabled) {
    return 'service_paused: Cogni AI features are temporarily disabled. Try again later.'
  }

  const allowed = await consumeAiQuota(userId, kind === 'write' ? 'mcp_write' : 'mcp_read')
  if (!allowed) {
    return kind === 'write'
      ? 'daily_limit: the daily MCP write budget is used up. It resets tomorrow.'
      : 'daily_limit: the daily MCP request budget is used up. It resets tomorrow.'
  }

  return null
}

// Fire-and-forget audit row per tool invocation — the MCP surface previously
// logged nothing, so abuse or breakage was invisible. Never blocks the call.
export function auditMcpCall(userId: string, tool: string, ok: boolean, detail?: string): void {
  const service = createServiceClient()
  void service
    .from('mcp_tool_calls')
    .insert({ user_id: userId, tool, ok, detail: detail?.slice(0, 500) ?? null })
    .then(() => {}, (e: unknown) => console.error('[mcp] audit insert failed', e))
}
