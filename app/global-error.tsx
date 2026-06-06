'use client'

// Last-resort boundary: catches errors thrown by the root layout itself, where
// the shell error.tsx can't help. Must render its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  console.error('[global] root error boundary caught', error)

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#fafafa', margin: 0 }}>
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Cogni hit an unexpected error</h2>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 16 }}>
            Your data is safe. Reload to get back to studying.
          </p>
          <button
            onClick={reset}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #333', background: '#fafafa', color: '#0a0a0a', fontSize: 14, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
