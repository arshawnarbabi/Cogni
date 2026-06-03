import type { NextConfig } from "next";

// Security headers for the public, multi-tenant deployment. These are the
// app-safe ones (clickjacking, MIME-sniffing, transport, referrer, permissions).
//
// NOTE: a FULL Content-Security-Policy (script-src / style-src / connect-src
// including your Supabase URL + AI provider origins) is NOT set here yet — a wrong
// CSP silently breaks the app, so it must be authored as `Content-Security-Policy-
// Report-Only` first, tuned against the running site, then enforced. Only the
// anti-clickjacking `frame-ancestors` directive (always safe) is enforced below.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
