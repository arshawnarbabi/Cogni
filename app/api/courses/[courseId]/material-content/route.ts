import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { serverError, apiError } from '@/lib/api-error'

const MAX_CHARS = 20_000

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { courseId } = await params
    const { searchParams } = new URL(request.url)
    const materialId = searchParams.get('id')
    if (!materialId) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const service = createServiceClient()

    const { data: mat, error: matError } = await service
      .from('materials')
      .select('material_id, filename, file_type, storage_path')
      .eq('material_id', materialId)
      .eq('course_id', courseId)
      .eq('user_id', user.id)
      .single()

    if (matError || !mat) return apiError('material_not_found', 404, { where: 'material-content/fetch', cause: matError })
    if (!mat.storage_path) return NextResponse.json({ error: 'Material has no storage path' }, { status: 422 })

    // Check if this is an image-only PDF by looking for embedding chunks
    if (mat.file_type === 'pdf') {
      const { data: chunks } = await service
        .from('material_embeddings')
        .select('content, chunk_index')
        .eq('material_id', materialId)
        .eq('user_id', user.id)
        .order('chunk_index', { ascending: true })
        .limit(1)

      // If we have chunks stored, use them (covers both normal and vision-extracted PDFs)
      if (chunks && chunks.length > 0) {
        const { data: allChunks } = await service
          .from('material_embeddings')
          .select('content')
          .eq('material_id', materialId)
          .eq('user_id', user.id)
          .order('chunk_index', { ascending: true })

        const content = (allChunks ?? []).map((c: { content: string }) => c.content).join('\n\n').slice(0, MAX_CHARS)
        return NextResponse.json({ content, filename: mat.filename })
      }
    }

    // Download from storage
    const { data: fileData, error: dlErr } = await service.storage
      .from('materials')
      .download(mat.storage_path)

    if (dlErr || !fileData) {
      return serverError('material-content/download', dlErr)
    }

    let content = ''

    if (mat.file_type === 'pdf') {
      try {
        const buffer = Buffer.from(await fileData.arrayBuffer())
        // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse')
        const parsed = await pdfParse(buffer)
        content = (parsed.text as string).slice(0, MAX_CHARS)
      } catch (e) {
        return apiError('pdf_parse_failed', 422, { where: 'material-content/pdf-parse', cause: e })
      }
    } else {
      content = (await fileData.text()).slice(0, MAX_CHARS)
    }

    return NextResponse.json({ content, filename: mat.filename })
  } catch (e) {
    return serverError('material-content', e)
  }
}
