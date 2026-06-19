import { recordUsage } from '@/lib/usage'
import type Anthropic from '@anthropic-ai/sdk'
import type { DocumentBlockParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'

// Shared text extraction for uploaded materials (PDF / text / images), including
// the vision fallback for image-only (scanned) PDFs and image files. Used by both
// the inbox classifier and the profiler so a scanned syllabus gets the same OCR
// treatment everywhere (previously the profiler had its own extraction WITHOUT the
// vision fallback, so onboarding silently extracted nothing from scanned PDFs).

export type ExtractResult = {
  text: string
  isImagePdf: boolean
  isImageFile: boolean
  imageMimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4MB — Anthropic limit is ~5MB

export async function compressImageIfNeeded(
  buffer: Buffer,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<{ buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  if (buffer.length <= MAX_IMAGE_BYTES) return { buffer, mimeType }
  try {
    // sharp is native and optional at runtime — lazy-load so a missing binary can't crash the route on import
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp')
    const compressed: Buffer = await sharp(buffer)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
    return { buffer: compressed, mimeType: 'image/jpeg' }
  } catch {
    return { buffer, mimeType }
  }
}

export async function extractText(buffer: Buffer, fileType: string, filename: string): Promise<ExtractResult> {
  const ext = fileType.toLowerCase().replace('.', '')

  if (ext === 'txt' || ext === 'md' || filename.endsWith('.txt') || filename.endsWith('.md')) {
    return { text: buffer.toString('utf-8'), isImagePdf: false, isImageFile: false }
  }

  if (ext === 'pdf' || filename.endsWith('.pdf')) {
    try {
      // pdf-parse must be lazy-loaded via require — its top-level code crashes at import time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(buffer)
      const meaningful = (data.text ?? '').replace(/\s+/g, '').length
      const isImagePdf = meaningful < 50
      return { text: data.text ?? '', isImagePdf, isImageFile: false }
    } catch {
      return { text: '', isImagePdf: true, isImageFile: false }
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    const mimeMap: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    }
    return { text: '', isImagePdf: false, isImageFile: true, imageMimeType: mimeMap[ext] ?? 'image/jpeg' }
  }

  return { text: `[File: ${filename}]`, isImagePdf: false, isImageFile: false }
}

// Builds the Anthropic content block for a vision pass over an image-only PDF or
// image file. Returns null when the extract result doesn't need vision.
export async function buildVisualBlock(
  buffer: Buffer,
  extract: ExtractResult,
): Promise<DocumentBlockParam | ImageBlockParam | null> {
  if (extract.isImagePdf) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
    } satisfies DocumentBlockParam
  }
  if (extract.isImageFile && extract.imageMimeType) {
    const { buffer: compressed, mimeType } = await compressImageIfNeeded(buffer, extract.imageMimeType)
    return {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: compressed.toString('base64') },
    } satisfies ImageBlockParam
  }
  return null
}

export const EXTRACT_PROMPT = `Transcribe all readable content from this document or image.
Include all text, equations, labels, headings, and problem statements exactly as they appear.
Format as plain text. Return ONLY the transcribed content, nothing else.`

export async function extractContentFromVision(
  client: Anthropic,
  visualBlock: DocumentBlockParam | ImageBlockParam,
  userId?: string,
): Promise<string> {
  try {
    const textBlock: TextBlockParam = { type: 'text', text: EXTRACT_PROMPT }
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [visualBlock, textBlock] }],
    })
    // C7 usage transparency (#30): the vision path sends the FULL document as
    // input tokens — the costliest part of an upload; it must show in Settings.
    if (userId) recordUsage(userId, 'inbox', 'claude-haiku-4-5-20251001', msg.usage)
    return msg.content[0].type === 'text' ? msg.content[0].text : ''
  } catch {
    return ''
  }
}
