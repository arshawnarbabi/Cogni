'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Turnstile } from '@/components/turnstile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { MIN_AGE } from '@/lib/legal'
import { toast } from 'sonner'

type Mode = 'signin' | 'signup' | 'forgot'

const SIGNUP_ERRORS: Record<string, string> = {
  missing_credentials: 'Enter an email and password.',
  weak_password: 'Password must be at least 8 characters.',
  consent_required: 'Please accept the Terms and confirm your age.',
  signups_paused: 'Signups are temporarily paused. Please check back soon.',
  captcha_failed: 'Captcha verification failed. Please try again.',
  email_not_allowed: 'Sign-ups are limited to approved email domains right now.',
  invite_required: 'An invite code is required to sign up.',
  invalid_invite: 'That invite code is invalid or already used.',
  signup_failed: 'Could not create your account. Please try again.',
}

// Password reset requires transactional email (SMTP). Deployments that run
// without email set NEXT_PUBLIC_PASSWORD_RESET_ENABLED=false to hide the
// (non-functional) "Forgot password?" flow and warn users their password can't
// be self-reset. Defaults to enabled.
const PASSWORD_RESET_ENABLED = process.env.NEXT_PUBLIC_PASSWORD_RESET_ENABLED !== 'false'

export default function AuthPage() {
  const router = useRouter()
  const supabase = createClient()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [consent, setConsent] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [cfg, setCfg] = useState<{ signupMode: string; signupsPaused: boolean; captcha: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/auth/config')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ signupMode: 'open', signupsPaused: false, captcha: false }))
  }, [])

  async function handleGoogle() {
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) {
      toast.error(error.message)
      setLoading(false)
    }
  }

  async function handleSignup() {
    if (!consent) {
      toast.error(`Please accept the Terms and confirm you are at least ${MIN_AGE}.`)
      return
    }
    if (cfg?.captcha && !captchaToken) {
      toast.error('Please complete the captcha.')
      return
    }
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        inviteCode: inviteCode || undefined,
        captchaToken: captchaToken || undefined,
        acceptedTerms: consent,
        ageAttested: consent,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(SIGNUP_ERRORS[data?.error] ?? 'Could not create your account.')
      return
    }
    if (data.confirmEmail) {
      toast.success('Check your email to confirm your account.')
      setMode('signin')
    } else {
      router.push('/')
    }
  }

  async function handleForgot() {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    })
    // Anti-enumeration: always show the same confirmation.
    if (error && !/rate/i.test(error.message)) {
      console.error('[auth] reset request error', error)
    }
    toast.success('If an account exists for that email, a reset link is on its way.')
    setMode('signin')
  }

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      if (mode === 'signup') {
        await handleSignup()
      } else if (mode === 'forgot') {
        await handleForgot()
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) toast.error('Invalid email or password.')
        else router.push('/')
      }
    } finally {
      setLoading(false)
    }
  }

  const submitLabel =
    loading ? 'Loading…'
    : mode === 'signin' ? 'Sign in with email'
    : mode === 'signup' ? 'Create account'
    : 'Send reset link'

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Left: form panel ─────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center gap-3">
            <Image src="/logo.svg" alt="Cogni" width={160} height={55} priority />
            <p className="text-sm text-muted-foreground md:text-base">
              {mode === 'forgot' ? 'Reset your password' : 'Sign in to get started'}
            </p>
          </div>

          {mode !== 'forgot' && (
            <>
              <Button
                onClick={handleGoogle}
                disabled={loading}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                size="lg"
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Continue with Google
              </Button>

              <p className="text-center text-[11px] leading-snug text-muted-foreground">
                By continuing you confirm you are at least {MIN_AGE} and agree to the{' '}
                <Link href="/legal/terms" target="_blank" className="underline">Terms</Link> and{' '}
                <Link href="/legal/privacy" target="_blank" className="underline">Privacy Policy</Link>.
              </p>

              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground">or</span>
                <Separator className="flex-1" />
              </div>
            </>
          )}

          {mode === 'signup' && cfg?.signupsPaused ? (
            <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              Signups are temporarily paused. Please check back soon.
            </p>
          ) : (
            <form onSubmit={handleEmailAuth} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@university.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>

              {mode !== 'forgot' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    {mode === 'signin' && PASSWORD_RESET_ENABLED && (
                      <button
                        type="button"
                        onClick={() => setMode('forgot')}
                        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={mode === 'signup' ? 8 : undefined}
                    disabled={loading}
                  />
                </div>
              )}

              {mode === 'signup' && cfg?.signupMode === 'invite' && (
                <div className="space-y-2">
                  <Label htmlFor="invite">Invite code</Label>
                  <Input
                    id="invite"
                    type="text"
                    placeholder="Your invite code"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required
                    disabled={loading}
                  />
                </div>
              )}

              {mode === 'signup' && (
                <>
                  {!PASSWORD_RESET_ENABLED && (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                      ⚠️ <strong>Save your password somewhere safe.</strong> Password reset isn&apos;t available on this
                      instance, so a forgotten password can&apos;t be recovered. Prefer <strong>Continue with Google</strong> above
                      — it needs no password.
                    </p>
                  )}
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                      required
                    />
                    <span>
                      I am at least {MIN_AGE} years old and agree to the{' '}
                      <Link href="/legal/terms" target="_blank" className="underline">Terms</Link> and{' '}
                      <Link href="/legal/privacy" target="_blank" className="underline">Privacy Policy</Link>.
                    </span>
                  </label>
                  {cfg?.captcha && <Turnstile onToken={setCaptchaToken} />}
                </>
              )}

              <Button type="submit" variant={mode === 'forgot' ? 'default' : 'outline'} className="w-full" disabled={loading}>
                {submitLabel}
              </Button>
            </form>
          )}

          <p className="text-center text-sm text-muted-foreground">
            {mode === 'signin' && (
              <>
                Don&apos;t have an account?{' '}
                <button onClick={() => setMode('signup')} className="text-primary underline-offset-4 hover:underline">Sign up</button>
              </>
            )}
            {mode === 'signup' && (
              <>
                Already have an account?{' '}
                <button onClick={() => setMode('signin')} className="text-primary underline-offset-4 hover:underline">Sign in</button>
              </>
            )}
            {mode === 'forgot' && (
              <button onClick={() => setMode('signin')} className="text-primary underline-offset-4 hover:underline">Back to sign in</button>
            )}
          </p>
        </div>
      </div>

      {/* ── Right: branded panel (desktop only) ──────────────── */}
      <div className="hidden md:flex md:w-[420px] lg:w-[480px] shrink-0 flex-col items-center justify-center gap-8 bg-primary px-12 py-16 relative overflow-hidden">
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-white/5" />
        <div className="absolute top-1/3 right-8 h-40 w-40 rounded-full bg-white/5" />
        <div className="relative flex flex-col items-center gap-6 text-center">
          <Image src="/logo-white.svg" alt="Cogni" width={240} height={82} priority />
          <p className="text-base text-white/70 lg:text-lg">Your personal AI study system.</p>
          <div className="mt-2 flex flex-col gap-3 text-left">
            {[
              'Learns how your professors test',
              'Builds your study plan automatically',
              'Adapts as your mastery grows',
            ].map((line) => (
              <div key={line} className="flex items-center gap-3 text-sm text-white/80 lg:text-base">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/60" />
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
