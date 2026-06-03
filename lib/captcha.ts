// Cloudflare Turnstile verification for the signup route.
//
// Opt-in: if TURNSTILE_SECRET_KEY is not set, verification is skipped (returns
// true) so the app works without CAPTCHA configured. Set both TURNSTILE_SECRET_KEY
// (server) and NEXT_PUBLIC_TURNSTILE_SITE_KEY (client widget) to enable it.

export function captchaEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY
}

export async function verifyTurnstile(token: string | null | undefined, ip?: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return true // not configured → skip
  if (!token) return false
  try {
    const form = new URLSearchParams({ secret, response: token })
    if (ip) form.append('remoteip', ip)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch (e) {
    console.error('[captcha] verify failed', e)
    return false
  }
}
