'use client'

import { useEffect, useState } from 'react'
import { Brain, Trash, Pause, Play } from '@phosphor-icons/react'

// Memory center (M7): what the tutor remembers about you — inspectable,
// deletable, pausable. Auto-extracted memory will sometimes be wrong; the
// student is the editor of record.

type Fact = { memory_id: string; course_id: string | null; kind: string; content: string; last_seen: string }
type Digest = { course_id: string; digest: string; updated_at: string }
type Summary = { summary_id: string; course_id: string; summary: string; created_at: string }

const KIND_LABELS: Record<string, string> = {
  preference: 'Preference',
  misconception: 'Watch out',
  goal: 'Goal',
  fact: 'Note',
}

export function MemoryCenter() {
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)
  const [courseNames, setCourseNames] = useState<Record<string, string>>({})
  const [digests, setDigests] = useState<Digest[]>([])
  const [facts, setFacts] = useState<Fact[]>([])
  const [summaries, setSummaries] = useState<Summary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmForgetAll, setConfirmForgetAll] = useState(false)

  useEffect(() => {
    fetch('/api/memory')
      .then(r => r.json())
      .then(d => {
        setPaused(!!d.paused)
        setCourseNames(d.courseNames ?? {})
        setDigests(d.digests ?? [])
        setFacts(d.facts ?? [])
        setSummaries(d.summaries ?? [])
      })
      .catch(() => setError('Could not load memory.'))
      .finally(() => setLoading(false))
  }, [])

  const hasMemory = digests.length > 0 || facts.length > 0 || summaries.length > 0

  async function togglePause() {
    const next = !paused
    setPaused(next)
    setBusy(true)
    try {
      const res = await fetch('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pause: next }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setPaused(!next)
      setError('Could not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(body: object, apply: () => void) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/memory', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
      apply()
    } catch {
      setError('Delete failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Brain size={15} className="text-primary" /> Tutor memory
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What the tutor remembers about you between sessions. You can delete anything — or pause new memory entirely.
          </p>
        </div>
        <button
          onClick={togglePause}
          disabled={busy || loading}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {paused ? <><Play size={12} /> Resume memory</> : <><Pause size={12} /> Pause memory</>}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {paused && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
          Memory is paused — the tutor keeps what it already knows but records nothing new.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !hasMemory ? (
        <p className="text-xs text-muted-foreground">Nothing remembered yet — memory builds up as you study with the tutor.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Per-course digests */}
          {digests.map(d => (
            <div key={d.course_id} className="flex flex-col gap-2 rounded-lg bg-muted/30 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">{courseNames[d.course_id] ?? 'Course'} — course memory</p>
                <button
                  onClick={() => remove({ courseId: d.course_id }, () => {
                    setDigests(prev => prev.filter(x => x.course_id !== d.course_id))
                    setFacts(prev => prev.filter(x => x.course_id !== d.course_id))
                    setSummaries(prev => prev.filter(x => x.course_id !== d.course_id))
                  })}
                  disabled={busy}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50"
                  title="Forget everything about this course"
                >
                  <Trash size={11} /> Forget course
                </button>
              </div>
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{d.digest}</p>
            </div>
          ))}

          {/* Structured facts */}
          {facts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-foreground">Things the tutor noted</p>
              {facts.map(f => (
                <div key={f.memory_id} className="flex items-start justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">{KIND_LABELS[f.kind] ?? f.kind}</span>
                    {f.content}
                    {f.course_id && courseNames[f.course_id] ? <span className="ml-1 opacity-60">· {courseNames[f.course_id]}</span> : null}
                  </p>
                  <button
                    onClick={() => remove({ memoryId: f.memory_id }, () => setFacts(prev => prev.filter(x => x.memory_id !== f.memory_id)))}
                    disabled={busy}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50"
                    title="Delete this memory"
                  >
                    <Trash size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Session summaries (collapsed list) */}
          {summaries.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">
                Session history ({summaries.length})
              </summary>
              <div className="mt-2 flex flex-col gap-1.5">
                {summaries.map(s => (
                  <div key={s.summary_id} className="flex items-start justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      <span className="opacity-60">{new Date(s.created_at).toLocaleDateString()}{courseNames[s.course_id] ? ` · ${courseNames[s.course_id]}` : ''} — </span>
                      {s.summary}
                    </p>
                    <button
                      onClick={() => remove({ summaryId: s.summary_id }, () => setSummaries(prev => prev.filter(x => x.summary_id !== s.summary_id)))}
                      disabled={busy}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50"
                      title="Delete this session summary"
                    >
                      <Trash size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Forget everything */}
          <div className="flex items-center justify-end">
            {confirmForgetAll ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-red-500">Delete ALL memory? This can’t be undone.</span>
                <button
                  onClick={() => remove({ all: true }, () => { setDigests([]); setFacts([]); setSummaries([]); setConfirmForgetAll(false) })}
                  disabled={busy}
                  className="rounded-lg bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-300"
                >
                  Yes, forget everything
                </button>
                <button onClick={() => setConfirmForgetAll(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmForgetAll(true)}
                disabled={busy}
                className="text-[11px] text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50"
              >
                Forget everything…
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
