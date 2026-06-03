import { getAppConfig } from '@/lib/app-config'
import { captchaEnabled } from '@/lib/captcha'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Public, safe-to-expose auth config for the sign-in page: which signup gate is
// active (so the UI can show an invite field), whether signups are paused, and
// whether CAPTCHA is on. Reveals no secrets.
export async function GET() {
  const cfg = await getAppConfig()
  return NextResponse.json({
    signupMode: cfg.signupMode,
    signupsPaused: cfg.signupsPaused,
    captcha: captchaEnabled(),
  })
}
