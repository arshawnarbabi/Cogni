// Tiny leveled logger. Centralizes the app's diagnostic output so hot-path
// noise (per-request usage, "skipping" traces) can be silenced in production
// while errors/warnings always surface.
//
// Levels:
//   error / warn  — always emitted (operational signal; Sentry separately
//                   captures thrown errors via lib/api-error.ts and lib/ai/call.ts).
//   info          — emitted except in production (useful in dev/preview).
//   debug         — emitted only when DEBUG_LOG=1 (off by default everywhere).
//
// Existing console.error calls across the codebase are intentionally left as-is
// (well-structured, Sentry-backed). Use this for new logging and for demoting
// chatty hot-path traces off the production console.
//
// NEVER pass secrets (API keys, tokens) or full user prompts as arguments.

const isProd = process.env.NODE_ENV === 'production'
const debugEnabled = process.env.DEBUG_LOG === '1'

export const log = {
  error(message: string, ...args: unknown[]): void {
    console.error(message, ...args)
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(message, ...args)
  },
  info(message: string, ...args: unknown[]): void {
    if (!isProd) console.info(message, ...args)
  },
  debug(message: string, ...args: unknown[]): void {
    if (debugEnabled) console.debug(message, ...args)
  },
}
