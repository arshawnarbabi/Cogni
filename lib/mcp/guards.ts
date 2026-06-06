import { createServiceClient } from '@/lib/supabase/server'
import { getAppConfig } from '@/lib/app-config'
import { consumeAiQuota } from '@/lib/rate-limit'

// Shared protective checks for every MCP tool handler (F4). The MCP server
// previously bypassed ALL of the in-app guards (verified bug B11): a suspended
// user — or any user during a global AI incident with the kill-switch flipped —
// could keep calling tools, and create_flashcards had no write budget at all
// (an unthrottled write surface on a long-lived token).
//
// One users-row read covers BOTH the suspended check and the timezone the tools
// need (previously two separate SELECTs per call). On the WRITE path the
// suspended check fails CLOSED: this is a long-lived bearer-token surface, so
// "couldn't read the suspension state" must deny, not allow.

export type McpGuardResult = {
  blocked: string | null
  timezone: string | null
}

export async function mcpGuard(userId: string, kind: 'read' | 'write'): Promise<McpGuardResult> {
  const service = createServiceClient()
  const { data: user, error } = await service
    .from('users')
    .select('suspended, timezone')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[mcp] guard users read failed', error)
    if (kind === 'write') {
      // Fail CLOSED on writes: can't confirm not-suspended → deny.
      return { blocked: 'service_unavailable: could not verify account state — try again shortly.', timezone: null }
    }
  }
  if (user?.suspended === true) {
    return { blocked: 'account_suspended: this Cogni account is suspended.', timezone: null }
  }

  // Kill-switch: fresh read on writes (must take effect immediately); the cached
  // config is fine for reads — they are frequent and harmless by comparison.
  const config = await getAppConfig(kind === 'write' ? { fresh: true } : undefined)
  if (config.aiDisabled) {
    return { blocked: 'service_paused: Cogni AI features are temporarily disabled. Try again later.', timezone: null }
  }

  // Read quota burns here. WRITE quota does NOT — write tools must validate
  // their inputs first and call consumeMcpWrite() themselves, so a rejected
  // request (bad topic_id etc.) doesn't eat the daily write budget.
  if (kind === 'read') {
    const allowed = await consumeAiQuota(userId, 'mcp_read')
    if (!allowed) {
      return { blocked: 'daily_limit: the daily MCP request budget is used up. It resets tomorrow.', timezone: null }
    }
  }

  return { blocked: null, timezone: (user?.timezone as string | undefined) ?? null }
}

/** Burn one unit of the daily MCP write budget. Call AFTER input validation.
 *  Returns an error string when exhausted, null when allowed. */
export async function consumeMcpWrite(userId: string): Promise<string | null> {
  const allowed = await consumeAiQuota(userId, 'mcp_write')
  return allowed ? null : 'daily_limit: the daily MCP write budget is used up. It resets tomorrow.'
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
