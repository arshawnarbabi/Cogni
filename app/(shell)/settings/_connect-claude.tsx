'use client'

import { useEffect, useState } from 'react'
import { Plugs, Copy, Check, ArrowsClockwise, Warning } from '@phosphor-icons/react'

export function ConnectClaude({ initialPreferOwnClaude }: { initialPreferOwnClaude: boolean }) {
  const [prefer, setPrefer] = useState(initialPreferOwnClaude)
  const [savingPref, setSavingPref] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [token, setToken] = useState<string | null>(null) // shown once after generate
  const [busy, setBusy] = useState(false)
  const [origin, setOrigin] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState('')

  const mcpUrl = origin ? `${origin}/api/mcp/mcp` : ''
  const connectCmd = `claude mcp add --transport http cogni ${mcpUrl} --header "Authorization: Bearer ${token ?? '<your-token>'}"`

  useEffect(() => {
    setOrigin(window.location.origin)
    fetch('/api/settings/mcp-token')
      .then(r => r.json())
      .then(d => setConnected(!!d.connected))
      .catch(() => setConnected(false))
  }, [])

  async function togglePref(next: boolean) {
    setPrefer(next)
    setSavingPref(true)
    setError('')
    try {
      const res = await fetch('/api/settings/tutor-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefer_own_claude: next }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setPrefer(!next)
      setError('Could not save that preference. Try again.')
    } finally {
      setSavingPref(false)
    }
  }

  async function generate() {
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/settings/mcp-token', { method: 'POST' })
      const d = await res.json()
      if (!res.ok || !d.token) throw new Error()
      setToken(d.token)
      setConnected(true)
    } catch {
      setError('Could not generate a connection token. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true); setError('')
    try {
      await fetch('/api/settings/mcp-token', { method: 'DELETE' })
      setToken(null); setConnected(false)
    } catch {
      setError('Could not disconnect. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1500)
    }).catch(() => {})
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Plugs size={16} className="text-indigo-500" weight="fill" />
        <p className="text-sm font-semibold text-foreground">Connect your Claude (MCP)</p>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Use your own Claude subscription to tutor yourself on your Cogni data. Connect Cogni to Claude Code or
        Claude Desktop; Claude reads your courses, materials, and weak topics and can make flashcards — on your
        plan, at no API cost. Cogni only serves data; the tutoring happens in your Claude client.
      </p>

      {/* Preference toggle */}
      <label className="flex items-start justify-between gap-3 rounded-lg bg-muted/30 px-3 py-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">Tutor with my own Claude</span>
          <span className="text-[11px] text-muted-foreground">When on, the Tutor tab shows connection instructions instead of the built-in tutor.</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={prefer}
          disabled={savingPref}
          onClick={() => togglePref(!prefer)}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${prefer ? 'bg-indigo-500' : 'bg-muted-foreground/30'} disabled:opacity-50`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-transform ${prefer ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </label>

      {/* Connection */}
      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">
            Connection {connected === null ? '' : connected ? '· Connected' : '· Not connected'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={generate}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {connected ? <ArrowsClockwise size={12} /> : <Plugs size={12} />}
              {connected ? 'Regenerate' : 'Generate connection'}
            </button>
            {connected && (
              <button onClick={revoke} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                Disconnect
              </button>
            )}
          </div>
        </div>

        {token && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-800/40 dark:bg-amber-950/20">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-400">
              <Warning size={13} weight="fill" /> Copy your token now — it won&apos;t be shown again.
            </p>
            <CodeRow value={token} onCopy={() => copy(token, 'tok')} copied={copied === 'tok'} />
          </div>
        )}

        {(token || connected) && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-muted-foreground">In a terminal with Claude Code installed, run:</p>
            <CodeRow value={connectCmd} onCopy={() => copy(connectCmd, 'cmd')} copied={copied === 'cmd'} mono />
            <p className="text-[11px] text-muted-foreground">
              Then in Claude Code, run <code className="rounded bg-muted px-1">/tutor</code> (or just ask “tutor me on my weakest topic”).
              MCP endpoint: <code className="rounded bg-muted px-1 break-all">{mcpUrl}</code>.
              For Claude Desktop, add it as a custom connector with the same URL + token.
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}

function CodeRow({ value, onCopy, copied, mono }: { value: string; onCopy: () => void; copied: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 p-2">
      <code className={`flex-1 overflow-x-auto whitespace-pre text-[11px] text-foreground ${mono ? 'font-mono' : 'font-mono'}`}>{value}</code>
      <button onClick={onCopy} className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Copy">
        {copied ? <Check size={13} className="text-emerald-500" weight="bold" /> : <Copy size={13} />}
      </button>
    </div>
  )
}
