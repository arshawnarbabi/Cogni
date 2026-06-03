import * as Sentry from '@sentry/nextjs'

// Edge-runtime error monitoring (middleware/proxy). No-op unless SENTRY_DSN set.
const dsn = process.env.SENTRY_DSN

Sentry.init({
  dsn,
  enabled: !!dsn,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
})
