import { createServiceClient } from '@/lib/supabase/server'

const BUCKET = 'wiki'

function storagePath(userId: string, filename: string) {
  return `${userId}/${filename}`
}

export async function readWikiFile(userId: string, filename: string): Promise<string | null> {
  const service = createServiceClient()
  const { data, error } = await service.storage
    .from(BUCKET)
    .download(storagePath(userId, filename))

  if (error || !data) return null
  return data.text()
}

export async function writeWikiFile(
  userId: string,
  filename: string,
  content: string,
  triggeredByAgent?: string
): Promise<void> {
  const service = createServiceClient()

  await service.storage
    .from(BUCKET)
    .upload(storagePath(userId, filename), new Blob([content], { type: 'text/markdown' }), {
      upsert: true,
    })

  await service.from('wiki_versions').insert({
    user_id: userId,
    file_path: filename,
    content,
    triggered_by_agent: triggeredByAgent ?? null,
  })
}

const LOG_FILE = 'log.md'
// Dedicated marker for single-line append rows so re-materialization never picks
// up full-blob snapshot rows (writeWikiFile / user PATCH both write file_path
// 'log.md' rows whose content is the WHOLE log) — joining those would duplicate
// the entire history on every subsequent append.
const LOG_APPEND_AGENT = 'log_append'

// Renders the log.md storage blob from append-only entry rows (one row per
// entry) ordered oldest-first, matching the historical newline-joined format.
function renderLogBlob(rows: Array<{ content: string }>): string {
  return rows.map(r => r.content).join('\n')
}

// Append-only log write (Phase 21 lost-update fix).
//
// The previous implementation did a read-modify-write of the log.md storage
// blob, so concurrent writers (e.g. profiler.ts inside Promise.all racing the
// inbox.ts appends) read the same baseline and the last upload clobbered the
// others' entries. Here each entry is persisted as its own append-only row in
// wiki_versions (file_path = 'log.md') via a single INSERT with no prior read,
// so concurrent appends can never overwrite one another — every entry is
// durably recorded. The log.md storage blob is then re-materialized from the
// full ordered set of rows so the existing storage readers (settings page and
// /api/wiki) keep seeing the complete, up-to-date log. Because the rows are the
// authoritative source and are never lost, any transient blob-write ordering is
// self-healing: the next append re-renders the complete set.
export async function appendToLog(userId: string, entry: string): Promise<void> {
  const service = createServiceClient()
  const timestamp = new Date().toISOString()
  const line = `- [${timestamp}] ${entry}`

  // Race-free append: a pure insert, no read-modify-write.
  await service.from('wiki_versions').insert({
    user_id: userId,
    file_path: LOG_FILE,
    content: line,
    triggered_by_agent: LOG_APPEND_AGENT,
  })

  // Re-materialize the storage blob from the committed append-entry rows ONLY
  // (LOG_APPEND_AGENT) so full-blob snapshot rows from writeWikiFile/PATCH can't
  // be folded in and duplicate the history. Read immediately before upload so the
  // blob reflects the latest committed entries, including concurrent appends.
  const { data: rows } = await service
    .from('wiki_versions')
    .select('content')
    .eq('user_id', userId)
    .eq('file_path', LOG_FILE)
    .eq('triggered_by_agent', LOG_APPEND_AGENT)
    .order('created_at', { ascending: true })

  const blob = renderLogBlob(rows ?? [{ content: line }]).trimStart()

  await service.storage
    .from(BUCKET)
    .upload(storagePath(userId, LOG_FILE), new Blob([blob], { type: 'text/markdown' }), {
      upsert: true,
    })
}

const INITIAL_FILES: Record<string, string> = {
  'learning_profile.md': `# Learning Profile

*This file is maintained by Cogni agents. It tracks your learning style, strengths, and areas for improvement.*

## Overview
No data yet. Profile will be built as you study.

## Strengths
*To be populated by the Profiler Agent.*

## Areas for Improvement
*To be populated by the Profiler Agent.*

## Study Preferences
*To be populated from onboarding and session history.*
`,
  'weak_areas.md': `# Weak Areas

*Updated by the Profiler Agent after each study session.*

No weak areas identified yet. Keep studying!
`,
  'index.md': `# Wiki Index

| File | Description |
|------|-------------|
| learning_profile.md | Your learning style and strengths |
| weak_areas.md | Topics needing extra review |
| log.md | Activity log |
`,
  'log.md': '',
}

export async function initWiki(userId: string): Promise<void> {
  const service = createServiceClient()

  // Check if already initialized
  const { data } = await service.storage
    .from(BUCKET)
    .list(userId, { limit: 1 })

  if (data && data.length > 0) return

  await Promise.all(
    Object.entries(INITIAL_FILES).map(([filename, content]) =>
      writeWikiFile(userId, filename, content, 'system')
    )
  )

  await appendToLog(userId, 'Wiki initialized after onboarding completion.')
}
