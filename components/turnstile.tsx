'use client'

import { useEffect, useRef } from 'react'

// Cloudflare Turnstile widget. Renders only when NEXT_PUBLIC_TURNSTILE_SITE_KEY
// is set; otherwise renders nothing and the signup route skips CAPTCHA. Calls
// onToken with the verification token (or '' when it expires/errors).

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      remove: (id: string) => void
    }
  }
}

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  useEffect(() => {
    if (!siteKey || !ref.current) return
    const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

    function render() {
      if (!window.turnstile || !ref.current || widgetId.current) return
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
    }

    if (window.turnstile) {
      render()
    } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.defer = true
      script.onload = render
      document.head.appendChild(script)
    } else {
      const t = setInterval(() => {
        if (window.turnstile) { clearInterval(t); render() }
      }, 200)
      return () => clearInterval(t)
    }

    return () => {
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current)
        widgetId.current = null
      }
    }
  }, [siteKey, onToken])

  if (!siteKey) return null
  return <div ref={ref} className="flex justify-center" />
}
