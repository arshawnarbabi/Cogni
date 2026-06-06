import * as Sentry from '@sentry/nextjs'
import { after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { runProfiler } from '@/lib/agents/profiler'
import { autoGenerateFlashcards } from '@/lib/agents/flashcard'
import { processEmbeddings } from '@/lib/rag'
import { isRetryable } from '@/lib/ai/call'

// ─────────────────────────────────────────────────────────────────────────────
// Durable job substrate (F1). The ingest pipeline's heavy tail (profiling,
// embedding, flashcard generation) used to run inline in request handlers
// (serverless-timeout risk on multi-syllabus onboarding) or as fire-and-forget
// promises (a throw after the HTTP 200 silently lost the work, no retry).
//
// Now: enqueueJob() persists a row in the request, kickJobs() drains it
// POST-response in the same lambda (next/server after(), so the user doesn't
// wait), and the daily scheduler cron sweeps anything a dead instance left
// behind (claim_jobs reclaims expired locks and fails exhausted attempts).
// Failures retry with backoff up to max_attempts and are visible in the jobs
// table instead of vanishing.
// ─────────────────────────────────────────────────────────────────────────────

export type JobKind = 'profile' | 'embed' | 'flashcards'

type JobRow = {
  job_id: string
  user_id: string
  kind: JobKind
  subject_id: string | null
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export async function enqueueJob(
  userId: string,
  kind: JobKind,
  opts: { subjectId?: string; payload?: Record<string, unknown>; runAfter?: Date } = {},
): Promise<string | null> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('jobs')
    .insert({
      user_id: userId,
      kind,
      subject_id: opts.subjectId ?? null,
      payload: opts.payload ?? {},
      ...(opts.runAfter ? { run_after: opts.runAfter.toISOString() } : {}),
    })
    .select('job_id')
    .single()
  if (error) {
    console.error('[jobs] enqueue failed', error)
    Sentry.captureException(error, { tags: { surface: 'jobs.enqueue', kind } })
    return null
  }
  return data?.job_id ?? null
}

// Drain due jobs after the current response is sent (after() keeps the lambda
// alive past the response on Vercel). Falls back to a detached promise outside
// a request scope (tests, scripts).
export function kickJobs(limit = 10): void {
  const run = () => processJobs(limit).catch(e => console.error('[jobs] kick drain failed', e))
  try {
    after(run)
  } catch {
    void run()
  }
}

async function dispatch(job: JobRow): Promise<void> {
  switch (job.kind) {
    case 'profile': {
      const { courseId, courseName, embed } = job.payload as { courseId?: string; courseName?: string; embed?: boolean }
      if (!job.subject_id || !courseId || !courseName) throw new Error('profile job missing subject_id/courseId/courseName')
      await runProfiler(job.user_id, job.subject_id, courseId, courseName, { embed: embed === true })
      // Topics now exist — pull forward any flashcards job that was delayed to
      // wait for them, so the same drain (next round) can pick it up.
      const service = createServiceClient()
      await service
        .from('jobs')
        .update({ run_after: new Date().toISOString() })
        .eq('user_id', job.user_id)
        .eq('kind', 'flashcards')
        .eq('status', 'queued')
        .eq('payload->>courseId', courseId)
      return
    }
    case 'embed': {
      const { text } = job.payload as { text?: string }
      if (!job.subject_id || !text) throw new Error('embed job missing subject_id/text')
      await processEmbeddings(job.user_id, job.subject_id, text)
      return
    }
    case 'flashcards': {
      const { courseId } = job.payload as { courseId?: string }
      if (!courseId) throw new Error('flashcards job missing courseId')
      await autoGenerateFlashcards(job.user_id, courseId)
      return
    }
  }
}

export async function processJobs(limit = 5, maxRounds = 3): Promise<{ claimed: number; succeeded: number; failed: number }> {
  let claimed = 0
  let succeeded = 0
  let failed = 0
  // Multiple rounds: a profile job's success pulls forward the dependent
  // flashcards job, which the next round then picks up in the same drain.
  for (let round = 0; round < maxRounds; round++) {
    const result = await processJobsOnce(limit)
    claimed += result.claimed
    succeeded += result.succeeded
    failed += result.failed
    if (result.claimed === 0) break
  }
  return { claimed, succeeded, failed }
}

async function processJobsOnce(limit: number): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const service = createServiceClient()
  const { data: jobs, error } = await service.rpc('claim_jobs', { p_limit: limit })
  if (error) {
    console.error('[jobs] claim failed', error)
    return { claimed: 0, succeeded: 0, failed: 0 }
  }

  let succeeded = 0
  let failed = 0
  for (const job of (jobs ?? []) as JobRow[]) {
    try {
      await dispatch(job)
      await service.from('jobs').update({ status: 'done', locked_until: null, updated_at: new Date().toISOString() }).eq('job_id', job.job_id)
      succeeded++
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const exhausted = job.attempts >= job.max_attempts
      const retryable = isRetryable(e) && !exhausted
      // Backoff: 1min, 4min, 16min between attempts.
      const backoffMs = 60_000 * 4 ** Math.max(0, job.attempts - 1)
      await service.from('jobs').update({
        status: retryable ? 'queued' : 'failed',
        run_after: retryable ? new Date(Date.now() + backoffMs).toISOString() : undefined,
        locked_until: null,
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('job_id', job.job_id)
      if (!retryable) {
        Sentry.captureException(e, { tags: { surface: 'jobs.dispatch', kind: job.kind } })
        failed++
      }
      console.error(`[jobs] ${job.kind} job ${job.job_id} attempt ${job.attempts} failed (${retryable ? 'will retry' : 'terminal'})`, e)
    }
  }

  return { claimed: (jobs ?? []).length, succeeded, failed }
}
