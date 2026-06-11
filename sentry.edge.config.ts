import * as Sentry from '@sentry/nextjs'

// Edge-runtime error monitoring (middleware/proxy). No-op unless SENTRY_DSN set.
const dsn = process.env.SENTRY_DSN

// H13: the calendar feed token travels in the URL path (inherent to ICS
// subscriptions) — scrub it from any event/transaction so an uncaught error in
// that route can't persist the live token in Sentry.
const scrubUrl = (u: unknown): string | undefined =>
  typeof u === 'string' ? u.replace(/(\/api\/calendar\/feed\/)[^/?#]+/g, '$1[token]') : undefined

type UrlEvent = { request?: { url?: string }; transaction?: string }
function scrubEvent<E extends UrlEvent>(event: E): E {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url) ?? event.request.url
  if (event.transaction) event.transaction = scrubUrl(event.transaction) ?? event.transaction
  return event
}


Sentry.init({
  dsn,
  enabled: !!dsn,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
})
