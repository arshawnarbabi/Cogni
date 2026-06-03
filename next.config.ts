import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Derive the Supabase origin (build-time) so connect-src can allow the app's
// own database/storage/realtime traffic.
const supabaseOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : "";
  } catch {
    return "";
  }
})();
const supabaseWs = supabaseOrigin.replace(/^http/, "ws");

// Content-Security-Policy, authored in REPORT-ONLY mode first. It reports
// violations to /api/csp-report without blocking anything, so it cannot break
// the app. Tune against real traffic (watch the reports), then promote the
// header name to `Content-Security-Policy` to enforce.
//
// script-src uses 'unsafe-inline' because next-themes injects an inline theme
// script and Next injects inline bootstrap scripts; moving to a strict nonce-
// based policy is the follow-up before enforcing.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseWs} https://challenges.cloudflare.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io`.replace(/\s+/g, " ").trim(),
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "report-uri /api/csp-report",
].join("; ");

// Security headers for the public, multi-tenant deployment.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Always-safe enforced directive (anti-clickjacking).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Full policy in report-only mode — tune, then enforce.
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// Sentry wrapping is benign without a DSN/auth token: source-map upload only runs
// when SENTRY_AUTH_TOKEN is set, and error capture is disabled without a DSN.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
