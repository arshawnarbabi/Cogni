'use client'

import { useState } from 'react'
import { Check, Eye, EyeSlash, X } from '@phosphor-icons/react'

export function VaultKeyField({
  label,
  description,
  placeholder,
  initialIsSet,
  initialPreview,
  learnMoreUrl,
}: {
  label: string
  description: string
  placeholder: string
  initialIsSet: boolean
  initialPreview: string | null
  learnMoreUrl?: string
}) {
  const [isSet, setIsSet] = useState(initialIsSet)
  const [preview, setPreview] = useState(initialPreview)
  const [input, setInput] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!input.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Failed to save key.')
        return
      }
      setIsSet(true)
      setPreview(`••••${input.trim().slice(-4)}`)
      setInput('')
      setEditing(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Network error. Your key was not saved.')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setError(null)
    const res = await fetch('/api/settings/api-key', { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to remove key.')
      return
    }
    setIsSet(false)
    setPreview(null)
    setEditing(false)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {isSet && !editing && (
          <span className="flex items-center gap-1 rounded-full bg-success-surface px-2 py-0.5 text-[11px] font-medium text-success">
            <Check size={10} weight="bold" /> Configured
          </span>
        )}
      </div>

      {isSet && !editing ? (
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground font-mono">
            {preview}
          </div>
          <button
            onClick={() => setEditing(true)}
            className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            Replace
          </button>
          <button
            onClick={remove}
            aria-label="Delete API key"
            className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={show ? 'text' : 'password'}
              value={input}
              onChange={e => { setInput(e.target.value); setError(null) }}
              onKeyDown={e => e.key === 'Enter' && save()}
              placeholder={placeholder}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            />
            <button
              type="button"
              onClick={() => setShow(s => !s)}
              aria-label={show ? 'Hide key' : 'Show key'}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {show ? <EyeSlash size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={save}
            disabled={!input.trim() || saving}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save'}
          </button>
          {editing && (
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {learnMoreUrl && (
        <a
          href={learnMoreUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary hover:underline"
        >
          Get a free API key →
        </a>
      )}
    </div>
  )
}
