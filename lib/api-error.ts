import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

// Stable, client-safe API error responses.
//
// Rule: NEVER return a raw Postgres / provider / exception message to the client
// — those leak internal schema, library internals, and sometimes data. Log the
// real cause server-side; return a stable machine-readable `code` the UI can
// branch on. Intentional semantic codes the client already depends on
// (e.g. 'rate_limited', 'no_openai_key', 'attachment_too_large') stay as-is —
// they are codes, not leaked internals.

export function apiError(
  code: string,
  status: number,
  log?: { where: string; cause?: unknown },
): NextResponse {
  if (log) {
    // Server-side only — the real error never crosses to the client.
    console.error(`[${log.where}] ${code}`, log.cause ?? '')
    // 5xx are OUR failures — route them to Sentry so they're visible in prod
    // (previously console.error only, i.e. invisible until a user complained).
    if (status >= 500) {
      Sentry.captureException(log.cause instanceof Error ? log.cause : new Error(`[${log.where}] ${code}`), {
        tags: { where: log.where },
      })
    }
  }
  return NextResponse.json({ error: code }, { status })
}

export const unauthorized = (where?: string) =>
  apiError('unauthorized', 401, where ? { where } : undefined)

export const forbidden = (code: string = 'forbidden') => apiError(code, 403)

export const notFound = (code: string = 'not_found') => apiError(code, 404)

export const badRequest = (code: string = 'bad_request') => apiError(code, 400)

/**
 * 500 with a generic, user-safe message. Pass `where` + `cause` so the true
 * error is logged (and captured by Sentry) while the client sees nothing
 * internal. Use this to replace any `error: someDbError.message` / `String(err)`.
 */
export const serverError = (where: string, cause?: unknown) =>
  apiError('Something went wrong. Please try again.', 500, { where, cause })
