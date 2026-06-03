import Link from 'next/link'
import { LEGAL_VERSION } from '@/lib/legal'

// Public legal section (Terms, Privacy, Acceptable Use). Reachable without auth
// — /legal is in proxy.ts publicRoutes. Kept deliberately simple and readable.
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10 flex items-center justify-between border-b pb-6">
          <Link href="/" className="text-lg font-semibold tracking-tight">Cogni</Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/legal/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/legal/acceptable-use" className="hover:text-foreground">Acceptable Use</Link>
          </nav>
        </header>
        <article className="space-y-5 text-sm leading-relaxed [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:font-medium [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6 [&_a]:underline [&_a]:underline-offset-2">
          {children}
        </article>
        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          Version {LEGAL_VERSION}. <Link href="/auth" className="underline">Back to sign in</Link>.
        </footer>
      </div>
    </div>
  )
}
