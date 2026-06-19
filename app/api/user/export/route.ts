import { createClient, createServiceClient } from '@/lib/supabase/server'
import { auditLog } from '@/lib/app-config'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GDPR/CCPA "export my data": returns every row the signed-in user owns, as a
// downloadable JSON file. Discovers all public tables that have a `user_id`
// column and dumps the caller's rows from each, plus their storage file paths.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Columns that must NEVER be exported even though their table is user-scoped —
  // live secrets. (Vault secrets aren't exported at all: they have no user_id
  // column so they're never in the table list.)
  const SECRET_COLUMNS: Record<string, string[]> = {
    user_keys: ['key_value'],
    calendar_connections: ['access_token', 'refresh_token'],
    // H11: the feed token is a live, non-expiring capability URL to the user's
    // full calendar — export files get archived/shared, so redact it too.
    users: ['calendar_feed_token'],
  }

  try {
    // Discover user-scoped tables via a SECURITY DEFINER RPC — information_schema
    // is not reachable through PostgREST, so a direct .from() would silently
    // return nothing (and a silently-empty export is itself a compliance failure).
    const { data: tableRows, error: catalogError } = await service.rpc('list_user_scoped_tables')
    if (catalogError) {
      return serverError('user/export:catalog', catalogError)
    }
    const tables: string[] = Array.from(new Set((tableRows ?? []) as string[]))

    const data: Record<string, unknown> = {}
    for (const table of tables) {
      const { data: rows, error } = await service.from(table).select('*').eq('user_id', user.id)
      if (error) {
        console.error(`[export] table ${table} failed`, error)
        data[table] = { error: 'unavailable' }
        continue
      }
      const redact = SECRET_COLUMNS[table]
      data[table] = redact
        ? (rows ?? []).map((row: Record<string, unknown>) => {
            const copy = { ...row }
            for (const col of redact) if (col in copy) copy[col] = '[redacted]'
            return copy
          })
        : (rows ?? [])
    }

    // Storage file listing (paths only) across the user's buckets. Recursive
    // (G6): list() returns one level only, and course files + syllabi live
    // under nested prefixes — a flat list silently omitted all of them.
    const buckets = ['materials', 'wiki', 'audio', 'course-files']
    const storage: Record<string, string[]> = {}
    for (const bucket of buckets) {
      const collect = async (prefix: string): Promise<string[]> => {
        const all: { id?: string | null; name: string }[] = []
        let offset = 0
        for (;;) {
          const { data: page } = await service.storage.from(bucket).list(prefix, { limit: 1000, offset })
          if (!page?.length) break
          all.push(...page)
          if (page.length < 1000) break
          offset += 1000
        }
        const nested = await Promise.all(all.map(async f => {
          const path = `${prefix}/${f.name}`
          return f.id ? [path] : collect(path) // folders have no id
        }))
        return nested.flat()
      }
      storage[bucket] = await collect(user.id)
    }

    await auditLog('data_export', { actor: user.id, subjectUserId: user.id })

    const payload = {
      exportedAt: new Date().toISOString(),
      userId: user.id,
      email: user.email,
      tables: data,
      storageFiles: storage,
    }

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="cogni-export-${user.id}.json"`,
      },
    })
  } catch (err) {
    return serverError('user/export', err)
  }
}
