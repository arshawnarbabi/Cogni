import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Receives Content-Security-Policy violation reports (from the Report-Only
// policy in next.config.ts). Logs a compact summary so you can tune the policy
// against real traffic before enforcing it. Public + unauthenticated by design
// (the browser posts here); never trust the body beyond logging.
// #47: this endpoint is attacker-postable by design, so everything that ends
// up in a log line is hostile input — cap the body, strip control chars (log-
// line forgery via \n), and truncate (multi-MB values flood volume-billed logs).
const MAX_REPORT_BYTES = 16_384
const safeLogValue = (v: unknown) => String(v ?? 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)

export async function POST(request: Request) {
  try {
    const len = Number(request.headers.get('content-length') ?? 0)
    if (len > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 })
    const body = await request.json()
    // Browsers send either { "csp-report": {...} } or a reports array.
    const report = body['csp-report'] ?? (Array.isArray(body) ? body[0]?.body : body)
    const directive = safeLogValue(report?.['violated-directive'] ?? report?.effectiveDirective)
    const blocked = safeLogValue(report?.['blocked-uri'] ?? report?.blockedURL)
    console.warn(`[csp-report] violated=${directive} blocked=${blocked}`)
  } catch {
    // Ignore malformed reports.
  }
  return new NextResponse(null, { status: 204 })
}
