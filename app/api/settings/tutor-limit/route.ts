import { createClient, createServiceClient } from '@/lib/supabase/server'
import { readJson, badRequest, finiteNumber, serverError } from '@/lib/api-error'
import { MAX_TUTOR_DAILY_LIMIT } from '@/lib/rate-limit'
import { NextResponse } from 'next/server'

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // readJson: malformed JSON is a 400, not an unhandled exception → 500.
  const body = await readJson<{ daily_message_limit: number | null }>(request)
  if (!body) return badRequest('invalid_json')
  const { daily_message_limit } = body

  // Bounded ABOVE as well as below: the tutor route uses this value verbatim,
  // so an unbounded self-set limit recreated the uncapped-Tutor state the
  // default cap was added to close (protects the shared free-tier project).
  if (daily_message_limit !== null
      && finiteNumber(daily_message_limit, { min: 1, max: MAX_TUTOR_DAILY_LIMIT, integer: true }) === null) {
    return NextResponse.json(
      { error: `Limit must be an integer between 1 and ${MAX_TUTOR_DAILY_LIMIT}` },
      { status: 400 },
    )
  }

  const service = createServiceClient()
  // Check the update result — a silent failure previously returned ok while
  // nothing was persisted.
  const { error } = await service.from('users').update({ daily_message_limit }).eq('user_id', user.id)
  if (error) return serverError('settings/tutor-limit', error)

  return NextResponse.json({ ok: true })
}
