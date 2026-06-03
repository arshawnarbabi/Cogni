// Pings an external dead-man's-switch monitor (e.g. Healthchecks.io, Better
// Stack) after a cron run so you get ALERTED if a cron stops running or starts
// failing — the cron handlers otherwise swallow failures into console.error,
// which no one watches.
//
// Configure (optional): CRON_HEARTBEAT_SCHEDULER_URL, CRON_HEARTBEAT_NUDGE_URL,
// CRON_HEARTBEAT_MAINTENANCE_URL. If unset, pinging is a no-op. Convention
// matches Healthchecks.io: ping the base URL on success, `${url}/fail` on failure.

export async function pingHeartbeat(url: string | undefined, ok: boolean): Promise<void> {
  if (!url) return
  try {
    await fetch(ok ? url : `${url}/fail`, { method: 'POST' })
  } catch (e) {
    console.error('[heartbeat] ping failed', e)
  }
}
