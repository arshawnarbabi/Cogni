'use client'

import { useCallback, useEffect, useState } from 'react'
import { GraduationCap, CircleNotch, ArrowsClockwise, LinkBreak } from '@phosphor-icons/react'

// Canvas import (S5): the student pastes their school's Canvas URL + a personal
// access token (Canvas → Account → Settings → "+ New Access Token"); we pull
// courses, due dates, the grading scheme, and their released grades.

type CanvasCourse = { id: string; name: string; term: string | null; current_score: number | null }
type CogniCourse = { course_id: string; name: string; lms_course_id: string | null }

export function CanvasPanel() {
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [tokenInvalid, setTokenInvalid] = useState(false)
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [canvasCourses, setCanvasCourses] = useState<CanvasCourse[]>([])
  const [cogniCourses, setCogniCourses] = useState<CogniCourse[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({}) // canvasId -> cogniId
  const [form, setForm] = useState({ url: '', token: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/lms/canvas')
      const d = await res.json()
      setConnected(!!d.connected)
      setTokenInvalid(!!d.tokenInvalid)
      setBaseUrl(d.baseUrl ?? null)
      setLastSyncedAt(d.lastSyncedAt ?? null)
      setCanvasCourses(d.canvasCourses ?? [])
      setCogniCourses(d.cogniCourses ?? [])
      // Pre-fill mappings from existing links.
      const pre: Record<string, string> = {}
      for (const c of (d.cogniCourses ?? []) as CogniCourse[]) {
        if (c.lms_course_id) pre[c.lms_course_id] = c.course_id
      }
      setMappings(pre)
    } catch {
      setError('Could not load Canvas status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function connect() {
    if (!form.url.trim() || !form.token.trim()) {
      setError('Both the Canvas URL and a token are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/lms/canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.url, token: form.token }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Connection failed.')
      setForm({ url: '', token: '' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport(sync: boolean) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body = sync
        ? { sync: true }
        : { mappings: Object.entries(mappings).filter(([, v]) => v).map(([canvasCourseId, cogniCourseId]) => ({ canvasCourseId, cogniCourseId })) }
      const res = await fetch('/api/lms/canvas/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error === 'token_invalid' ? 'Canvas rejected the saved token — reconnect with a fresh one.' : (d.error ?? 'Import failed.'))
      const totals = (d.results ?? []).reduce(
        (acc: { g: number; a: number }, r: { gradeItems: number; assignments: number }) => ({ g: acc.g + r.gradeItems, a: acc.a + r.assignments }),
        { g: 0, a: 0 },
      )
      setNotice(`Imported ${totals.g} grade${totals.g === 1 ? '' : 's'} and ${totals.a} upcoming assignment${totals.a === 1 ? '' : 's'} across ${(d.results ?? []).length} course${(d.results ?? []).length === 1 ? '' : 's'}${(d.skipped ?? []).length > 0 ? ` (${d.skipped.length} skipped)` : ''}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await fetch('/api/lms/canvas', { method: 'DELETE' })
      setConnected(false)
      setCanvasCourses([])
      setNotice('')
    } finally {
      setBusy(false)
    }
  }

  const linkedCount = Object.values(mappings).filter(Boolean).length

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <GraduationCap size={15} className="text-primary" /> Canvas import
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pull your assignments, due dates, grading scheme, and released grades straight from your school&apos;s Canvas.
          </p>
        </div>
        {connected && (
          <button onClick={disconnect} disabled={busy}
            className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50">
            <LinkBreak size={11} /> Disconnect
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !connected || tokenInvalid ? (
        <div className="flex flex-col gap-2">
          {tokenInvalid && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
              Canvas rejected the saved token — generate a fresh one and reconnect.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            In Canvas: <span className="font-medium text-foreground">Account → Settings → “+ New Access Token”</span>. Copy it immediately (Canvas only shows it once). Some schools disable self-service tokens — if you don&apos;t see the button, ask your IT help desk.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 min-w-44 flex-col gap-1 text-[11px] text-muted-foreground">
              Your school&apos;s Canvas URL
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="school.instructure.com" className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
            </label>
            <label className="flex flex-1 min-w-44 flex-col gap-1 text-[11px] text-muted-foreground">
              Access token
              <input value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
                type="password" placeholder="paste token" className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
            </label>
            <button onClick={connect} disabled={busy}
              className="rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy ? <CircleNotch size={13} className="animate-spin" /> : 'Connect'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[11px] text-muted-foreground">
            Connected to <span className="font-medium text-foreground">{baseUrl}</span>
            {lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleString()}` : ''}
          </p>

          {canvasCourses.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active Canvas courses found for this account.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium text-foreground">Match each Canvas course to a Cogni course:</p>
              {canvasCourses.map(cc => (
                <div key={cc.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{cc.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {cc.term ?? 'Canvas'}{cc.current_score !== null ? ` · current: ${cc.current_score}%` : ''}
                    </p>
                  </div>
                  <select
                    value={mappings[cc.id] ?? ''}
                    onChange={e => setMappings(m => ({ ...m, [cc.id]: e.target.value }))}
                    className="shrink-0 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                  >
                    <option value="">don&apos;t import</option>
                    {cogniCourses.map(c => (
                      <option key={c.course_id} value={c.course_id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="mt-1 flex items-center gap-2">
                <button onClick={() => runImport(false)} disabled={busy || linkedCount === 0}
                  className="rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                  {busy ? <CircleNotch size={13} className="animate-spin" /> : `Import ${linkedCount} course${linkedCount === 1 ? '' : 's'}`}
                </button>
                <button onClick={() => runImport(true)} disabled={busy}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
                  <ArrowsClockwise size={12} /> Sync linked
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
