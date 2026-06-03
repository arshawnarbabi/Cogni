'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'

// Landing page for the password-recovery email link. Supabase sends the user
// here with a one-time code; we exchange it for a short recovery session, then
// let them set a new password (auth.updateUser).
export default function ResetPasswordPage() {
  const router = useRouter()
  const supabase = createClient()
  const [status, setStatus] = useState<'verifying' | 'ready' | 'invalid'>('verifying')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (!code) {
      // Some Supabase configs deliver a recovery session via the URL hash and
      // fire a PASSWORD_RECOVERY event instead of providing a code.
      supabase.auth.getSession().then(({ data }) => {
        setStatus(data.session ? 'ready' : 'invalid')
      })
      return
    }
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      setStatus(error ? 'invalid' : 'ready')
    })
  }, [supabase])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      toast.error('Could not update password. The link may have expired — request a new one.')
      return
    }
    toast.success('Password updated. You are signed in.')
    router.push('/today')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3">
          <Image src="/logo.svg" alt="Cogni" width={160} height={55} priority />
          <p className="text-sm text-muted-foreground">Set a new password</p>
        </div>

        {status === 'verifying' && (
          <p className="text-center text-sm text-muted-foreground">Verifying your reset link…</p>
        )}

        {status === 'invalid' && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              This reset link is invalid or has expired.
            </p>
            <Button variant="outline" className="w-full" onClick={() => router.push('/auth')}>
              Back to sign in
            </Button>
          </div>
        )}

        {status === 'ready' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                disabled={loading}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Saving…' : 'Update password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
