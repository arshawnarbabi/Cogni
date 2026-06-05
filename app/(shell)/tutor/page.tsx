import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plugs, ArrowRight } from '@phosphor-icons/react/dist/ssr'
import { TutorClient } from './_client'
import { getUserApiKey } from '@/lib/vault'

export const dynamic = 'force-dynamic'

export default async function TutorPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()

  const [{ data: courses }, { data: sessions }, anthropicKey, { data: userRow }] = await Promise.all([
    service
      .from('courses')
      .select('course_id, name, icon, icon_color, professors(name)')
      .eq('user_id', user.id)
      .eq('active_status', 'active')
      .order('created_at', { ascending: true }),
    service
      .from('session_log')
      .select('session_id, course_id, name, mode, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
    getUserApiKey(user.id),
    service.from('users').select('prefer_own_claude').eq('user_id', user.id).single(),
  ])

  // "Bring your own Claude" mode: the student tutors in their own Claude client via
  // the MCP connector, so the in-app tutor is replaced by connection guidance.
  if (userRow?.prefer_own_claude) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-indigo-500/10">
            <Plugs size={24} className="text-indigo-500" weight="fill" />
          </div>
          <div>
            <h2 className="font-heading text-lg font-semibold text-foreground">Tutoring with your own Claude</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              You&apos;ve turned on <span className="font-medium text-foreground">Bring your own Claude</span>. Tutor yourself in
              Claude Code or Claude Desktop using your Cogni data — it reads your courses, materials, and weak topics
              and can make flashcards, on your own subscription. Everything else in Cogni works as normal.
            </p>
          </div>
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Set up the connection in Settings <ArrowRight size={15} />
          </Link>
          <p className="text-xs text-muted-foreground">Prefer the built-in tutor? Turn this off in Settings → Connect your Claude.</p>
        </div>
      </div>
    )
  }

  return <TutorClient courses={courses ?? []} sessions={sessions ?? []} hasApiKey={!!anthropicKey} />
}
