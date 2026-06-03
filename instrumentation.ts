import * as Sentry from '@sentry/nextjs'

// Next.js instrumentation hook — loads the right Sentry config per runtime and
// forwards uncaught server/edge request errors to Sentry (no-op without a DSN).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
