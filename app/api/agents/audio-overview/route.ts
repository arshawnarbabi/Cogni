import { recordUsage } from '@/lib/usage'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserApiKey } from '@/lib/vault'
import { getUserKey } from '@/lib/user-keys'
import { aiRouteGuard } from '@/lib/rate-limit'
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

export const maxDuration = 60

type ScriptSegment = { host: 'A' | 'B'; text: string }

function parseScript(raw: string): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  const lines = raw.split('\n')
  for (const line of lines) {
    const matchA = line.match(/^\[Host A\]:\s*(.+)/)
    const matchB = line.match(/^\[Host B\]:\s*(.+)/)
    if (matchA && matchA[1].trim()) segments.push({ host: 'A', text: matchA[1].trim() })
    else if (matchB && matchB[1].trim()) segments.push({ host: 'B', text: matchB[1].trim() })
  }
  return segments
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const courseId = searchParams.get('courseId')
  if (!courseId) return NextResponse.json({ overviews: [] })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ overviews: [] })

  const service = createServiceClient()

  const { data: files } = await service.storage.from('audio').list(user.id, { limit: 20 })

  const overviews: { url: string; created_at: number }[] = []
  for (const file of files ?? []) {
    if (!file.name.startsWith(`${courseId}_`)) continue
    const filePath = `${user.id}/${file.name}`
    const { data: signed } = await service.storage.from('audio').createSignedUrl(filePath, 7200)
    if (!signed?.signedUrl) continue
    const tsMatch = file.name.match(/_(\d+)\.mp3$/)
    const ts = tsMatch ? parseInt(tsMatch[1]) : 0
    overviews.push({ url: signed.signedUrl, created_at: ts })
  }

  overviews.sort((a, b) => b.created_at - a.created_at)
  return NextResponse.json({ overviews })
}

export async function POST(request: Request) {
  const { courseId } = await request.json() as { courseId: string }
  if (!courseId) return NextResponse.json({ error: 'Missing courseId' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const guard = await aiRouteGuard(user.id, 'audio_overview')
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const openaiKey = await getUserKey(user.id, 'openai_key')
  if (!openaiKey) {
    return NextResponse.json({ error: 'no_openai_key' }, { status: 402 })
  }

  const anthropicKey = await getUserApiKey(user.id)
  if (!anthropicKey) return NextResponse.json({ error: 'No Anthropic API key configured' }, { status: 402 })

  const service = createServiceClient()

  // Fetch course name
  const { data: course } = await service
    .from('courses')
    .select('name')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .single()

  if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

  // Fetch up to 5 processed materials (Tier 1–3 priority)
  const { data: materials } = await service
    .from('materials')
    .select('material_id, storage_path, filename, file_type, tier')
    .eq('course_id', courseId)
    .eq('user_id', user.id)
    .eq('processing_status', 'processed')
    .in('tier', [1, 2, 3])
    .order('tier', { ascending: true })
    .order('uploaded_at', { ascending: false })
    .limit(5)

  if (!materials || materials.length === 0) {
    return NextResponse.json({ error: 'No processed materials found. Upload course materials first.' }, { status: 404 })
  }

  // Extract text from each material
  const textParts: string[] = []
  for (const mat of materials) {
    if (!mat.storage_path) continue
    const { data: fileData } = await service.storage.from('materials').download(mat.storage_path)
    if (!fileData) continue
    const buffer = Buffer.from(await fileData.arrayBuffer())

    let text = ''
    if (mat.file_type === 'pdf') {
      try {
        // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse')
        const parsed = await pdfParse(buffer)
        text = parsed.text
      } catch {
        text = buffer.toString('utf-8')
      }
    } else {
      text = buffer.toString('utf-8')
    }

    if (text.trim().length > 100) {
      const tierLabel = ['', 'Syllabus', 'Lecture Notes / Past Exam', 'Study Guide', 'Graded Material'][mat.tier ?? 4]
      textParts.push(`=== ${mat.filename ?? 'Untitled'} (${tierLabel}) ===\n${text.slice(0, 8000)}`)
    }
  }

  if (textParts.length === 0) {
    return NextResponse.json({ error: 'Could not extract text from materials' }, { status: 500 })
  }

  const combinedText = textParts.join('\n\n')

  // Generate two-host script with Sonnet
  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const scriptMessage = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are producing a podcast-style audio study guide for a college student studying ${course.name}.

Write a two-host conversational script from the course material below.

Format rules — follow exactly:
- Every line must start with either [Host A]: or [Host B]:
- No other text, no stage directions, no introductory notes
- Host A explains concepts clearly and precisely, as a knowledgeable peer
- Host B asks the questions a studying student would ask — clarifying, connecting, probing
- Alternate hosts frequently (every 2–4 sentences)
- Each host turn is 1–3 sentences
- Cover the most exam-important concepts from the material
- Total length: approximately 2,500–2,800 words of dialogue
- Begin immediately with [Host A]: opening the show

Course material:
${combinedText.slice(0, 20000)}`,
    }],
  })
  recordUsage(user.id, 'audio_overview', 'claude-sonnet-4-6', scriptMessage.usage) // #30

  const scriptRaw = scriptMessage.content[0].type === 'text' ? scriptMessage.content[0].text : ''
  const segments = parseScript(scriptRaw)

  if (segments.length === 0) {
    return NextResponse.json({ error: 'Script generation produced no dialogue' }, { status: 500 })
  }

  // Generate TTS for each segment in parallel batches
  const { default: OpenAI } = await import('openai')
  const openai = new OpenAI({ apiKey: openaiKey })

  const BATCH_SIZE = 10
  const audioBuffers: Buffer[] = []

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(seg =>
        openai.audio.speech.create({
          model: 'tts-1',
          voice: seg.host === 'A' ? 'alloy' : 'nova',
          input: seg.text,
          response_format: 'mp3',
        }).then(r => r.arrayBuffer())
      )
    )
    for (const ab of batchResults) {
      audioBuffers.push(Buffer.from(ab))
    }
  }

  const combined = Buffer.concat(audioBuffers)

  // Upload to audio bucket
  const filePath = `${user.id}/${courseId}_${Date.now()}.mp3`
  const { error: uploadError } = await service.storage
    .from('audio')
    .upload(filePath, combined, { contentType: 'audio/mpeg', upsert: false })

  if (uploadError) {
    console.error('[audio-overview] upload failed', uploadError)
    return NextResponse.json({ error: 'Failed to store audio' }, { status: 500 })
  }

  // Retention: keep only the latest AUDIO_KEEP_PER_COURSE overviews per course so
  // generated MP3s don't accumulate unbounded (the biggest free-tier storage sink).
  const AUDIO_KEEP_PER_COURSE = 3
  try {
    const { data: existing } = await service.storage.from('audio').list(user.id, { limit: 100 })
    const mine = (existing ?? [])
      .filter((f: { name: string }) => f.name.startsWith(`${courseId}_`))
      .map((f: { name: string }) => ({ name: f.name, ts: Number(f.name.match(/_(\d+)\.mp3$/)?.[1] ?? 0) }))
      .sort((a: { ts: number }, b: { ts: number }) => b.ts - a.ts)
    const stale = mine.slice(AUDIO_KEEP_PER_COURSE)
    if (stale.length > 0) {
      await service.storage.from('audio').remove(stale.map((s: { name: string }) => `${user.id}/${s.name}`))
    }
  } catch (e) {
    console.error('[audio-overview] retention prune failed', e)
  }

  const { data: signedUrlData } = await service.storage.from('audio').createSignedUrl(filePath, 3600)
  if (!signedUrlData?.signedUrl) {
    return NextResponse.json({ error: 'Failed to create audio URL' }, { status: 500 })
  }

  const segmentCount = segments.length
  const wordCount = segments.reduce((sum, s) => sum + s.text.split(' ').length, 0)
  const estimatedMinutes = Math.round(wordCount / 130)

  return NextResponse.json({
    url: signedUrlData.signedUrl,
    path: filePath,
    estimated_minutes: estimatedMinutes,
    segment_count: segmentCount,
  })
}
