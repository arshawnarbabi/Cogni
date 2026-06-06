'use client'

import { useEffect } from 'react'

// Route-level error boundary for every shell tab. Without this, any render-path
// failure (a slow agent call, a partially-provisioned account, a transient DB
// error) hard-500s the page with a white screen — the documented prod failure
// mode. Degrade to a friendly retry instead.
export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[shell] route error boundary caught', error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card px-8 py-10 text-center">
        <div className="text-4xl">😵‍💫</div>
        <h2 className="text-lg font-semibold">Something went wrong loading this page</h2>
        <p className="text-sm text-muted-foreground">
          This is usually temporary. Your data is safe — try again, and if it keeps
          happening, refresh the page or check back in a minute.
        </p>
        <button
          onClick={reset}
          className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
