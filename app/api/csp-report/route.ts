import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Receives Content-Security-Policy violation reports (from the Report-Only
// policy in next.config.ts). Logs a compact summary so you can tune the policy
// against real traffic before enforcing it. Public + unauthenticated by design
// (the browser posts here); never trust the body beyond logging.
export async function POST(request: Request) {
  try {
    const body = await request.json()
    // Browsers send either { "csp-report": {...} } or a reports array.
    const report = body['csp-report'] ?? (Array.isArray(body) ? body[0]?.body : body)
    const directive = report?.['violated-directive'] ?? report?.effectiveDirective ?? 'unknown'
    const blocked = report?.['blocked-uri'] ?? report?.blockedURL ?? 'unknown'
    console.warn(`[csp-report] violated=${directive} blocked=${blocked}`)
  } catch {
    // Ignore malformed reports.
  }
  return new NextResponse(null, { status: 204 })
}
