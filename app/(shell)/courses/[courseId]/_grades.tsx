'use client'

import { useCallback, useEffect, useState } from 'react'
import { Exam, Plus, Trash, CircleNotch } from '@phosphor-icons/react'

// Grade tracker (S1): current weighted grade + "what do I need on the rest?" —
// the question students actually google before finals.

type Scheme = { category: string; weight_pct: number }
type Item = { item_id: string; category: string | null; name: string; points_earned: number | null; points_possible: number; graded_at: string; source: string }
type Summary = {
  mode: 'weighted' | 'points'
  current_pct: number | null
  graded_weight_pct: number
  by_category: { category: string; weight_pct: number; earned_pct: number | null; graded_count: number }[]
  uncategorized_count: number
}
type WhatIf = { target_pct: number; needed_pct: number | null; achievable: boolean; already_secured: boolean }

function gradeColor(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground'
  if (pct >= 90) return 'text-emerald-600 dark:text-emerald-400'
  if (pct >= 80) return 'text-green-600 dark:text-green-400'
  if (pct >= 70) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

export function CourseGrades({ courseId }: { courseId: string }) {
  const [loading, setLoading] = useState(true)
  const [scheme, setScheme] = useState<Scheme[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [whatIf, setWhatIf] = useState<WhatIf[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', category: '', earned: '', possible: '' })

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/grades?courseId=${courseId}`)
      if (!res.ok) throw new Error()
      const d = await res.json()
      setScheme(d.scheme ?? [])
      setItems(d.items ?? [])
      setSummary(d.summary ?? null)
      setWhatIf(d.whatIf ?? [])
    } catch {
      setError('Could not load grades.')
    } finally {
      setLoading(false)
    }
  }, [courseId])

  useEffect(() => { void load() }, [load])

  async function addItem() {
    const possible = parseFloat(form.possible)
    const earned = form.earned.trim() === '' ? null : parseFloat(form.earned)
    if (!form.name.trim() || !Number.isFinite(possible) || possible <= 0) {
      setError('Name and a positive "out of" are required.')
      return
    }
    if (earned !== null && (!Number.isFinite(earned) || earned < 0)) {
      setError('Score must be a number (or blank if not graded yet).')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/grades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          name: form.name.trim(),
          category: form.category || null,
          points_earned: earned,
          points_possible: possible,
        }),
      })
      if (!res.ok) throw new Error()
      setForm({ name: '', category: '', earned: '', possible: '' })
      setAdding(false)
      await load()
    } catch {
      setError('Could not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function removeItem(itemId: string) {
    setBusy(true)
    try {
      const res = await fetch('/api/grades', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      })
      if (!res.ok) throw new Error()
      await load()
    } catch {
      setError('Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Grades</h2>
        <div className="h-20 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Exam size={15} className="text-primary" /> Grades
        </h2>
        <button
          onClick={() => setAdding(a => !a)}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Plus size={11} /> Add grade
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* Current grade + what-if */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-baseline gap-4">
          <div>
            <p className={`text-2xl font-semibold tabular-nums ${gradeColor(summary?.current_pct ?? null)}`}>
              {summary?.current_pct !== null && summary?.current_pct !== undefined ? `${summary.current_pct}%` : '—'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              current grade{summary?.mode === 'weighted' && summary.graded_weight_pct > 0 ? ` · ${summary.graded_weight_pct}% of the course graded` : ''}
            </p>
          </div>
          {summary?.mode === 'weighted' && summary.by_category.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {summary.by_category.map(c => (
                <span key={c.category} className="text-[11px] text-muted-foreground">
                  {c.category} ({c.weight_pct}%): <span className={`font-medium ${gradeColor(c.earned_pct)}`}>{c.earned_pct !== null ? `${c.earned_pct}%` : '—'}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {whatIf.some(w => w.needed_pct !== null) && (
          <>
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-medium text-foreground">To finish the course with…</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {whatIf.map(w => (
                  <span key={w.target_pct} className="text-[11px] text-muted-foreground">
                    {w.target_pct}%: {w.already_secured
                      ? <span className="font-medium text-emerald-600 dark:text-emerald-400">secured ✓</span>
                      : w.needed_pct === null
                        ? <span className="font-medium">{w.achievable ? 'done ✓' : 'not reached'}</span>
                        : w.achievable
                          ? <span className="font-medium text-foreground">need {w.needed_pct}% on the rest</span>
                          : <span className="font-medium text-red-500">out of reach ({w.needed_pct}%)</span>}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3">
          <label className="flex flex-1 min-w-36 flex-col gap-1 text-[11px] text-muted-foreground">
            Name
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Midterm 1" className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
          </label>
          {scheme.length > 0 && (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Category
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                <option value="">—</option>
                {scheme.map(s => <option key={s.category} value={s.category}>{s.category}</option>)}
              </select>
            </label>
          )}
          <label className="flex w-20 flex-col gap-1 text-[11px] text-muted-foreground">
            Score
            <input value={form.earned} onChange={e => setForm(f => ({ ...f, earned: e.target.value }))}
              placeholder="84" inputMode="decimal" className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
          </label>
          <label className="flex w-20 flex-col gap-1 text-[11px] text-muted-foreground">
            Out of
            <input value={form.possible} onChange={e => setForm(f => ({ ...f, possible: e.target.value }))}
              placeholder="100" inputMode="decimal" className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
          </label>
          <button onClick={addItem} disabled={busy}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {busy ? <CircleNotch size={13} className="animate-spin" /> : 'Save'}
          </button>
        </div>
      )}

      {/* Items */}
      {items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {items.map(i => (
            <div key={i.item_id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">{i.name}</p>
                <p className="text-[10px] text-muted-foreground">
                  {i.category ?? 'uncategorized'}{i.source === 'canvas' ? ' · from Canvas' : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs tabular-nums text-foreground">
                  {i.points_earned !== null ? `${i.points_earned}/${i.points_possible}` : `—/${i.points_possible}`}
                </span>
                {i.source !== 'canvas' && (
                  <button onClick={() => removeItem(i.item_id)} disabled={busy}
                    className="text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50" title="Delete">
                    <Trash size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {items.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">
          No grades yet — add them as you get them back{scheme.length > 0 ? ' (the grading scheme came from your syllabus)' : ''}, or connect Canvas in Settings to import them automatically.
        </p>
      )}
    </div>
  )
}
