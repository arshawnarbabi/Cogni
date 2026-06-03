// Single source of truth for legal/consent metadata. The signup flow records
// LEGAL_VERSION against each new account (users.tos_version / privacy_version)
// so you can prove which version a user accepted. Bump LEGAL_VERSION whenever
// the Terms or Privacy Policy change materially.

export const LEGAL_VERSION = '2026-06-03'

// Minimum age to use the service (COPPA floor in the US is 13). Attested at signup.
export const MIN_AGE = 13

// ───────────────────────────────────────────────────────────────────────────
// TODO (operator): replace these placeholders with your real details before
// public launch. They render verbatim in the Terms/Privacy pages.
export const COMPANY_NAME = 'Cogni'
export const CONTACT_EMAIL = 'support@trycogni.com'
export const GOVERNING_LAW = 'the State of California, USA' // TODO: your jurisdiction
// ───────────────────────────────────────────────────────────────────────────

// Third-party processors that may receive user data. Disclosed in the Privacy
// Policy. Note: the AI providers are accessed with the USER's own API key (BYOK).
export const SUBPROCESSORS: { name: string; purpose: string }[] = [
  { name: 'Supabase', purpose: 'Database, authentication, and encrypted file/secret storage' },
  { name: 'Vercel', purpose: 'Application hosting and content delivery' },
  { name: 'Anthropic (Claude)', purpose: 'AI tutoring, syllabus analysis, and study-content generation — called with your own API key' },
  { name: 'OpenAI', purpose: 'Text embeddings (search) and text-to-speech (audio overviews) — called with your own API key' },
  { name: 'Google', purpose: 'Optional Google sign-in and Google Calendar sync, only if you connect them' },
]
