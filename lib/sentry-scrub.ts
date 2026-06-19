// H13: the calendar feed token travels in the URL path (inherent to ICS
// subscriptions) — scrub it from any Sentry event/transaction so an uncaught
// error in that route can't persist the live token in error telemetry.
// Extracted from the Sentry configs so it can be unit-tested directly (the
// config files run Sentry.init on import and aren't importable in tests).

export const scrubUrl = (u: unknown): string | undefined =>
  typeof u === 'string' ? u.replace(/(\/api\/calendar\/feed\/)[^/?#]+/g, '$1[token]') : undefined

type UrlEvent = { request?: { url?: string }; transaction?: string }

export function scrubEvent<E extends UrlEvent>(event: E): E {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url) ?? event.request.url
  if (event.transaction) event.transaction = scrubUrl(event.transaction) ?? event.transaction
  return event
}
