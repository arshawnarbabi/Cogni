'use client'

import { useEffect, useState } from 'react'
import { CalendarPlus, Copy, Check, ArrowsClockwise } from '@phosphor-icons/react'

// ICS subscription feed (S4): works with Apple Calendar / Outlook / Google —
// read-only, no OAuth, no write access to the student's calendar. The
// complement to the Google-write integration above it.
export function CalendarFeed() {
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    setOrigin(window.location.origin)
    fetch('/api/settings/calendar-feed')
      .then(r => r.json())
      .then(d => setToken(d.token ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const feedUrl = token && origin ? `${origin}/api/calendar/feed/${token}.ics` : ''

  async function generate() {
    setBusy(true)
    try {
      const res = await fetch('/api/settings/calendar-feed', { method: 'POST' })
      const d = await res.json()
      if (d.token) setToken(d.token)
    } catch { /* leave state */ } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CalendarPlus size={15} className="text-primary" /> Calendar feed (any calendar app)
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Subscribe once and your exams, due dates, and study blocks appear in Apple Calendar, Outlook, or Google — read-only, auto-updating.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : token ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">{feedUrl}</code>
            <button onClick={copy} className="shrink-0 rounded-lg border border-border p-2 text-foreground transition-colors hover:bg-muted" title="Copy feed URL">
              {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              In Apple Calendar: File → New Calendar Subscription. In Google Calendar: Other calendars → From URL.
            </p>
            <button
              onClick={generate}
              disabled={busy}
              className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              title="Rotating invalidates the old URL"
            >
              <ArrowsClockwise size={11} /> Rotate URL
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={generate}
          disabled={busy}
          className="self-start rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate feed URL'}
        </button>
      )}
    </section>
  )
}
