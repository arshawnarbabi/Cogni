'use client'

import { useEffect, useState } from 'react'
import { ChartBar } from '@phosphor-icons/react'

// Usage & Cost panel (C7): BYOK means the student pays — show them what their
// key actually spent, by surface, and what caching saved. Estimates from a
// static price map; the provider invoice is the source of truth.

type Summary = {
  days: number
  totalCostUsd: number
  cacheSavingsUsd: number
  bySurface: { surface: string; calls: number; costUsd: number; inputTokens: number; outputTokens: number }[]
}

const SURFACE_LABELS: Record<string, string> = {
  tutor: 'Tutor',
  quiz: 'Practice quizzes',
  flashcards: 'Flashcard generation',
  profiler: 'Syllabus analysis',
  memory: 'Session memory',
}

export function UsagePanel() {
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/user/usage')
      .then(r => r.json())
      .then(d => setData(d.error ? null : d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ChartBar size={15} className="text-primary" /> Usage &amp; cost (last 30 days)
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Estimated spend on your own API keys. Your provider&apos;s invoice is the exact number.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !data || data.bySurface.length === 0 ? (
        <p className="text-xs text-muted-foreground">No AI usage recorded yet — it starts tracking from your next tutor session.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-4">
            <div>
              <p className="text-lg font-semibold tabular-nums text-foreground">${data.totalCostUsd.toFixed(2)}</p>
              <p className="text-[11px] text-muted-foreground">estimated spend</p>
            </div>
            {data.cacheSavingsUsd > 0 && (
              <div>
                <p className="text-lg font-semibold tabular-nums text-green-600 dark:text-green-400">${data.cacheSavingsUsd.toFixed(2)}</p>
                <p className="text-[11px] text-muted-foreground">saved by prompt caching</p>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {data.bySurface.map(s => (
              <div key={s.surface} className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                <span className="text-xs text-foreground">{SURFACE_LABELS[s.surface] ?? s.surface}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {s.calls} call{s.calls === 1 ? '' : 's'} · ${s.costUsd.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
