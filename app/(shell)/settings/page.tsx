import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getUserApiKey } from '@/lib/vault'
import { getUserKey } from '@/lib/user-keys'
import { DevResetButton } from './_dev-reset'
import { CalendarSection } from './_calendar-section'
import { CalendarToast } from './_calendar-toast'
import { VaultKeyField } from './_vault-key-field'
import { ApiKeyField } from './_key-field'
import { SessionLengthPicker } from './_session-length'
import { TutorLimitPicker } from './_tutor-limit'
import { AppearancePicker } from './_appearance'
import { AccountSection } from './_account'
import { KnowledgeStore } from './_knowledge-store'
import { ConnectClaude } from './_connect-claude'
import { MemoryCenter } from './_memory'
import { CheckCircle, XCircle } from '@phosphor-icons/react/dist/ssr'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const service = createServiceClient()
  const isDev = process.env.NODE_ENV === 'development'

  const [calRow, userData, anthropicKey, openaiKey, materialsData, wikiFiles, professorsData] = await Promise.all([
    service.from('calendar_connections').select('cogni_calendar_id').eq('user_id', user.id).eq('provider', 'google').single(),
    service.from('users').select('session_length_preference, display_name, daily_message_limit, prefer_own_claude').eq('user_id', user.id).single(),
    getUserApiKey(user.id),
    getUserKey(user.id, 'openai_key'),
    service.from('materials').select('course_id, tier, uploaded_at').eq('user_id', user.id).eq('processing_status', 'processed'),
    service.storage.from('wiki').list(user.id, { limit: 100 }),
    service.from('professors').select('professor_id, name').eq('user_id', user.id),
  ])

  const connected = !!calRow.data
  const calendarName = calRow.data ? 'Cogni Study' : null
  const sessionLength = (userData.data?.session_length_preference as number) ?? 45
  const dailyMessageLimit = (userData.data?.daily_message_limit as number | null) ?? null
  const preferOwnClaude = (userData.data?.prefer_own_claude as boolean | undefined) ?? false
  const anthropicIsSet = !!anthropicKey && anthropicKey.length > 0
  const anthropicPreview = anthropicIsSet ? `••••${anthropicKey!.slice(-4)}` : null
  const openaiIsSet = !!openaiKey && openaiKey.length > 0

  const { data: courses } = await service
    .from('courses')
    .select('course_id, name')
    .eq('user_id', user.id)
    .eq('active_status', 'active')
    .order('name')

  const materials = materialsData.data ?? []

  // Build wiki files list with content
  const HIDDEN = new Set(['index.md'])
  type StorageFile = { name: string; updated_at?: string }
  const visibleWikiFiles = (wikiFiles.data ?? []).filter((f: StorageFile) => !HIDDEN.has(f.name))
  const wikiFilesWithContent = await Promise.all(
    visibleWikiFiles.map(async (f: StorageFile) => {
      const { data } = await service.storage.from('wiki').download(`${user.id}/${f.name}`)
      const content = data ? await data.text() : ''
      return { filename: f.name, content, updated_at: f.updated_at ?? null }
    })
  )

  // Professor ID → name map
  const professorMap: Record<string, string> = {}
  for (const p of professorsData.data ?? []) {
    professorMap[p.professor_id] = p.name
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-8 p-6 max-w-2xl">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">API keys, preferences, calendar, and account.</p>
        </div>

        <Suspense fallback={null}><CalendarToast /></Suspense>

        {/* AI & API Keys */}
        <section className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">AI &amp; API Keys</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Keys are stored securely and never returned to your browser.</p>
          </div>
          <VaultKeyField
            label="Anthropic API Key"
            description="Required — powers all AI features (Tutor, Profiler, Flashcards, Practice Tests)"
            placeholder="sk-ant-..."
            initialIsSet={anthropicIsSet}
            initialPreview={anthropicPreview}
            learnMoreUrl="https://console.anthropic.com/settings/keys"
          />
          <div className="h-px bg-border" />
          <ApiKeyField
            keyName="openai_key"
            label="OpenAI API Key"
            description="Optional — enables audio overviews (TTS) and semantic search (RAG)"
            placeholder="sk-proj-..."
            learnMoreUrl="https://platform.openai.com/api-keys"
          />
          <div className="h-px bg-border" />
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground">Daily Tutor Message Limit</p>
            <p className="text-xs text-muted-foreground">Cap how many messages you can send to Tutor per day. Resets at midnight.</p>
            <TutorLimitPicker initial={dailyMessageLimit} />
          </div>
        </section>

        {/* Study Preferences */}
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">Study Preferences</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Cogni uses your session length to schedule daily study blocks.</p>
          </div>
          <SessionLengthPicker initial={sessionLength} />
        </section>

        {/* Connect your Claude (MCP) */}
        <ConnectClaude initialPreferOwnClaude={preferOwnClaude} />

        {/* Calendar */}
        <CalendarSection connected={connected} calendarName={calendarName} />

        {/* Appearance */}
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">Appearance</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Choose your preferred colour scheme.</p>
          </div>
          <AppearancePicker />
        </section>

        {/* System Status */}
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">System Status</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Health of your Cogni setup at a glance.</p>
          </div>
          <div className="flex flex-col gap-2">
            <StatusRow label="Anthropic API Key" ok={anthropicIsSet} />
            <StatusRow label="OpenAI API Key" ok={openaiIsSet} note="optional" />
          </div>
          {courses && courses.length > 0 && (
            <>
              <div className="h-px bg-border" />
              <div className="flex flex-col gap-2">
                {courses.map((course: { course_id: string; name: string }) => {
                  const courseMats = materials.filter((m: { course_id: string; tier: number; uploaded_at: string }) => m.course_id === course.course_id)
                  const hasSyllabus = courseMats.some((m: { tier: number }) => m.tier === 1)
                  const hasPrimary = courseMats.some((m: { tier: number }) => m.tier === 2)
                  const lastUpload = courseMats.reduce((latest: string | null, m: { uploaded_at: string }) => {
                    if (!latest || m.uploaded_at > latest) return m.uploaded_at
                    return latest
                  }, null)
                  return (
                    <div key={course.course_id} className="flex flex-col gap-1 rounded-lg bg-muted/30 px-3 py-2.5">
                      <p className="text-xs font-semibold text-foreground">{course.name}</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <StatusRow label="Syllabus" ok={hasSyllabus} small />
                        <StatusRow label="Lecture notes / primary material" ok={hasPrimary} small />
                        {lastUpload && (
                          <span className="text-[11px] text-muted-foreground">
                            Last upload: {new Date(lastUpload).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>

        {/* Tutor memory (M7) */}
        <MemoryCenter />

        {/* Knowledge Store */}
        <KnowledgeStore files={wikiFilesWithContent} professorMap={professorMap} />

        {/* Account */}
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">Account</p>
            {userData.data?.display_name && (
              <p className="mt-0.5 text-xs text-muted-foreground">Signed in as {userData.data.display_name}</p>
            )}
          </div>
          <AccountSection />
        </section>

        {/* Dev tools */}
        {isDev && (
          <div className="rounded-xl border border-dashed border-red-200 bg-red-50/50 p-5 dark:border-red-900/40 dark:bg-red-950/20">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">Developer tools</p>
            <p className="mt-0.5 text-xs text-red-600/80 dark:text-red-500/80">Only visible in development.</p>
            <div className="mt-4">
              <DevResetButton />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusRow({ label, ok, note, small }: { label: string; ok: boolean; note?: string; small?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${small ? '' : ''}`}>
      {ok
        ? <CheckCircle size={small ? 13 : 15} weight="fill" className="text-emerald-500 shrink-0" />
        : <XCircle size={small ? 13 : 15} weight="fill" className="text-red-400 shrink-0" />
      }
      <span className={`${small ? 'text-[11px]' : 'text-xs'} text-foreground`}>{label}</span>
      {note && <span className="text-[11px] text-muted-foreground">({note})</span>}
    </div>
  )
}
