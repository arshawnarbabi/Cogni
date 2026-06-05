import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'

// Per-user bearer tokens for the Cogni MCP server. A user connects their own Claude
// client (Claude Code / Desktop) to Cogni's MCP endpoint with one of these; the
// token scopes every tool call to that user's data. We store only the SHA-256 HASH
// of the token (never the plaintext), so a DB leak can't reveal usable tokens.

const PREFIX = 'cogni_mcp_'

export function hashMcpToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Generate a fresh token. Returns the plaintext (shown to the user ONCE) and the
 *  hash (the only thing we persist). */
export function generateMcpToken(): { token: string; hash: string } {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url')
  return { token, hash: hashMcpToken(token) }
}

export type McpAuthInfo = {
  token: string
  clientId: string
  scopes: string[]
  extra: { userId: string }
}

/** withMcpAuth verifier: (request, bearerToken) -> AuthInfo | undefined.
 *  Returning undefined makes mcp-handler reject the request with 401. */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string,
): Promise<McpAuthInfo | undefined> {
  if (!bearerToken || !bearerToken.startsWith(PREFIX)) return undefined

  const hash = hashMcpToken(bearerToken)
  const service = createServiceClient()
  const { data } = await service
    .from('mcp_tokens')
    .select('user_id')
    .eq('token_hash', hash)
    .maybeSingle()

  if (!data?.user_id) return undefined

  // Best-effort last-used stamp; never block auth on it.
  void service
    .from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', hash)
    .then(() => {}, () => {})

  return {
    token: bearerToken,
    clientId: data.user_id as string,
    scopes: ['cogni:read', 'cogni:write'],
    extra: { userId: data.user_id as string },
  }
}
