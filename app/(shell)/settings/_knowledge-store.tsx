'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText,
  Pencil,
  Trash,
  FloppyDisk,
  X,
  CaretDown,
  CaretUp,
  Warning,
  User,
} from '@phosphor-icons/react'

type WikiFile = {
  filename: string
  content: string
  updated_at: string | null
}

type ProfessorMap = Record<string, string> // professor_id → name

function severityFor(filename: string): 'high' | 'medium' | 'low' {
  if (filename === 'learning_profile.md' || filename === 'weak_areas.md') return 'high'
  if (filename.startsWith('professor_')) return 'medium'
  return 'low'
}

function labelFor(filename: string, professorMap: ProfessorMap): string {
  if (filename === 'learning_profile.md') return 'Learning Profile'
  if (filename === 'weak_areas.md') return 'Weak Areas'
  if (filename === 'log.md') return 'Activity Log'
  if (filename.startsWith('professor_')) {
    const id = filename.replace('professor_', '').replace('.md', '')
    return `Professor: ${professorMap[id] ?? 'Unknown'}`
  }
  return filename
}

function DeleteWarning({
  label,
  severity,
  onConfirm,
  onCancel,
}: {
  label: string
  severity: 'high' | 'medium' | 'low'
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')

  const messages: Record<typeof severity, string> = {
    high: 'This permanently erases Cogni\'s accumulated understanding of your learning. It will rebuild over time, but all current insights will be lost.',
    medium: 'Cogni will lose all knowledge about this professor\'s exam style and preferences. It will rebuild as you study.',
    low: 'This file will be permanently deleted.',
  }

  const canConfirm = severity !== 'high' || typed === 'DELETE'

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <Warning size={14} weight="fill" className="text-destructive shrink-0 mt-0.5" />
        <p className="text-xs text-destructive leading-relaxed">{messages[severity]}</p>
      </div>
      {severity === 'high' && (
        <input
          type="text"
          placeholder='Type "DELETE" to confirm'
          value={typed}
          onChange={e => setTyped(e.target.value)}
          className="rounded-md border border-destructive/40 bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive/50"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={!canConfirm}
          className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 transition-colors"
        >
          Delete {label}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function WikiFileRow({
  file,
  label,
  onSaved,
}: {
  file: WikiFile
  label: string
  onSaved: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(file.content)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const severity = severityFor(file.filename)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/wiki', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.filename, content: draft }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error ?? 'Failed to save. Your changes were not saved.')
        setSaving(false)
        return
      }
      setSaving(false)
      setEditing(false)
      onSaved()
    } catch {
      setError('Network error. Your changes were not saved.')
      setSaving(false)
    }
  }

  async function handleDelete() {
    setError(null)
    try {
      const res = await fetch('/api/wiki', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.filename }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error ?? 'Failed to delete.')
        return
      }
      router.refresh()
    } catch {
      setError('Network error. Could not delete.')
    }
  }

  const isProfessor = file.filename.startsWith('professor_')

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 shrink-0">
          {isProfessor
            ? <User size={13} weight="fill" className="text-primary" />
            : <FileText size={13} weight="fill" className="text-primary" />
          }
        </div>
        <div className="flex flex-1 flex-col min-w-0">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {file.updated_at && (
            <span className="text-[11px] text-muted-foreground">
              Updated {new Date(file.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!editing && (
            <button
              onClick={() => { setEditing(true); setExpanded(true); setConfirmDelete(false) }}
              aria-label="Edit"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            >
              <Pencil size={13} />
            </button>
          )}
          <button
            onClick={() => { setConfirmDelete(v => !v); setEditing(false) }}
            aria-label="Delete"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <Trash size={13} />
          </button>
          <button
            onClick={() => { setExpanded(v => !v); if (editing) setEditing(false) }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            {expanded ? <CaretUp size={13} /> : <CaretDown size={13} />}
          </button>
        </div>
      </div>

      {expanded && !editing && (
        <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
          {file.content || <span className="italic">Empty</span>}
        </div>
      )}

      {editing && (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="min-h-48 w-full rounded-lg border border-border bg-background p-3 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              <FloppyDisk size={12} />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(file.content) }}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              <X size={12} />
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {confirmDelete && (
        <DeleteWarning
          label={label}
          severity={severity}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {error && !editing && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function KnowledgeStore({
  files,
  professorMap,
}: {
  files: WikiFile[]
  professorMap: ProfessorMap
}) {
  const router = useRouter()

  const systemFiles = files.filter(f =>
    ['learning_profile.md', 'weak_areas.md', 'log.md'].includes(f.filename)
  )
  const professorFiles = files.filter(f => f.filename.startsWith('professor_'))

  if (files.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">Knowledge Store</p>
        <p className="mt-1 text-xs text-muted-foreground">No wiki files yet. They&apos;ll appear here as Cogni learns about you.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold text-foreground">Knowledge Store</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cogni&apos;s memory about you. Edit or delete entries — changes take effect immediately.
        </p>
      </div>

      {systemFiles.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">System</p>
          {systemFiles.map(f => (
            <WikiFileRow
              key={f.filename}
              file={f}
              label={labelFor(f.filename, professorMap)}
              onSaved={() => router.refresh()}
            />
          ))}
        </div>
      )}

      {professorFiles.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Professor Profiles</p>
          {professorFiles.map(f => (
            <WikiFileRow
              key={f.filename}
              file={f}
              label={labelFor(f.filename, professorMap)}
              onSaved={() => router.refresh()}
            />
          ))}
        </div>
      )}
    </div>
  )
}
