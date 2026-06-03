import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()

  // Verify ownership
  const { data: topic } = await service
    .from('topics')
    .select('topic_id')
    .eq('topic_id', topicId)
    .eq('user_id', user.id)
    .single()

  if (!topic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete flashcards for this topic explicitly (FK is set null, not cascade)
  const { error: flashcardError } = await service.from('flashcards').delete().eq('topic_id', topicId).eq('user_id', user.id)
  if (flashcardError) return serverError('topics/[topicId] DELETE flashcards', flashcardError)

  // Delete topic — cascades to topic_mastery
  const { error: topicError } = await service.from('topics').delete().eq('topic_id', topicId).eq('user_id', user.id)
  if (topicError) return serverError('topics/[topicId] DELETE topic', topicError)

  return NextResponse.json({ ok: true })
}
