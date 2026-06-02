import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  convertInchesToTwip,
} from 'docx'

function htmlToDocxParagraphs(html: string): Paragraph[] {
  const paragraphs: Paragraph[] = []

  // Strip tags and parse block-level elements naively
  const blocks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/<\/?(?:p|h[1-6]|li|ul|ol|blockquote)[^>]*>/i)
    .map(b => b.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
    .filter(Boolean)

  // Detect heading levels from original html
  const h1Texts = new Set<string>()
  const h2Texts = new Set<string>()
  ;(html.match(/<h1[^>]*>(.*?)<\/h1>/gi) ?? []).forEach(m => {
    const t = m.replace(/<[^>]+>/g, '').trim()
    if (t) h1Texts.add(t)
  })
  ;(html.match(/<h2[^>]*>(.*?)<\/h2>/gi) ?? []).forEach(m => {
    const t = m.replace(/<[^>]+>/g, '').trim()
    if (t) h2Texts.add(t)
  })

  for (const text of blocks) {
    if (!text) continue

    if (h1Texts.has(text)) {
      paragraphs.push(new Paragraph({
        text,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 160 },
      }))
    } else if (h2Texts.has(text)) {
      paragraphs.push(new Paragraph({
        text,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 120 },
      }))
    } else {
      for (const line of text.split('\n')) {
        if (line.trim()) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line, size: 24, font: 'Calibri' })],
            spacing: { after: 160, line: 360 },
            alignment: AlignmentType.LEFT,
          }))
        }
      }
    }
  }

  return paragraphs.length ? paragraphs : [new Paragraph({ text: '' })]
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { html, title } = await request.json() as { html: string; title?: string }

  if (typeof html !== 'string') return NextResponse.json({ error: 'Missing html' }, { status: 400 })
  if (html.length > 1_000_000) return NextResponse.json({ error: 'Document too large' }, { status: 413 })

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.25),
            right: convertInchesToTwip(1.25),
          },
        },
      },
      children: [
        ...(title ? [new Paragraph({
          text: title,
          heading: HeadingLevel.TITLE,
          spacing: { after: 400 },
        })] : []),
        ...htmlToDocxParagraphs(html),
      ],
    }],
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 24 },
          paragraph: { spacing: { line: 360 } },
        },
      },
    },
  })

  const buffer = await Packer.toBuffer(doc)

  const safeTitle = (title ?? 'essay').replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 100).trim() || 'essay'

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${safeTitle}.docx"`,
    },
  })
}
