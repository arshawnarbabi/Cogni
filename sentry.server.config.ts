import * as Sentry from '@sentry/nextjs'

// Server-side error monitoring. No-op unless SENTRY_DSN is set, so local/dev and
// any deploy without the env var are unaffected.
const dsn = process.env.SENTRY_DSN

Sentry.init({
  dsn,
  enabled: !!dsn,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  sendDefaultPii: false, // never attach user PII to events
})
