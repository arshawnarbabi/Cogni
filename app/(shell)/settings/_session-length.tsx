'use client'

import { useState } from 'react'

const OPTIONS = [
  { value: 25, label: 'Short', duration: '25 min' },
  { value: 45, label: 'Medium', duration: '45 min' },
  { value: 90, label: 'Long', duration: '90 min' },
] as const

export function SessionLengthPicker({ initial }: { initial: number }) {
  const [selected, setSelected] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function pick(value: number) {
    if (value === selected) return
    const prev = selected
    setSelected(value)
    setSaving(true)
    try {
      const res = await fetch('/api/settings/session-length', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionLength: value }),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setSelected(prev)
      }
    } catch {
      setSelected(prev)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => pick(opt.value)}
            disabled={saving}
            className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl border py-3 transition-colors disabled:opacity-60 ${
              selected === opt.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <span className="text-sm font-semibold">{opt.label}</span>
            <span className="text-xs">{opt.duration}</span>
          </button>
        ))}
      </div>
      {saved && <p className="text-xs text-success">Saved</p>}
    </div>
  )
}
