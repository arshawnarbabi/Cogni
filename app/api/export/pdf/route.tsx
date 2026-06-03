import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
  Font,
} from '@react-pdf/renderer'
import React from 'react'

// Register Plus Jakarta Sans via Google Fonts CDN
Font.register({
  family: 'PlusJakartaSans',
  fonts: [
    { src: 'https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaPj7z4eTGEgB4E3dVh8KTsLJEJBhANk.woff2', fontWeight: 400 },
    { src: 'https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaPj7z4eTGEgB4E3dVh8KTsLJEJBhANk.woff2', fontWeight: 600 },
    { src: 'https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaPj7z4eTGEgB4E3dVh8KTsLJEJBhANk.woff2', fontWeight: 700 },
  ],
})

const styles = StyleSheet.create({
  page: {
    fontFamily: 'PlusJakartaSans',
    fontSize: 11,
    paddingTop: 72,
    paddingBottom: 72,
    paddingLeft: 90,
    paddingRight: 90,
    color: '#0F172A',
    lineHeight: 1.6,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 24,
    color: '#0F172A',
  },
  h1: {
    fontSize: 16,
    fontWeight: 700,
    marginTop: 20,
    marginBottom: 8,
    color: '#0F172A',
  },
  h2: {
    fontSize: 13,
    fontWeight: 600,
    marginTop: 16,
    marginBottom: 6,
    color: '#0F172A',
  },
  paragraph: {
    marginBottom: 10,
    lineHeight: 1.7,
  },
})

function htmlToPdfElements(html: string, title?: string): React.ReactNode[] {
  const elements: React.ReactNode[] = []
  if (title) {
    elements.push(<Text key="title" style={styles.title}>{title}</Text>)
  }

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

  const blocks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/<\/?(?:p|h[1-6]|li|ul|ol|blockquote)[^>]*>/i)
    .map(b => b.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
    .filter(Boolean)

  blocks.forEach((text, i) => {
    if (!text) return
    if (h1Texts.has(text)) {
      elements.push(<Text key={i} style={styles.h1}>{text}</Text>)
    } else if (h2Texts.has(text)) {
      elements.push(<Text key={i} style={styles.h2}>{text}</Text>)
    } else {
      elements.push(<Text key={i} style={styles.paragraph}>{text}</Text>)
    }
  })

  return elements
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { html, title } = await request.json() as { html: string; title?: string }

  if (typeof html !== 'string') return NextResponse.json({ error: 'Missing html' }, { status: 400 })
  if (html.length > 1_000_000) return NextResponse.json({ error: 'Document too large' }, { status: 413 })

  const doc = (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View>
          {htmlToPdfElements(html, title)}
        </View>
      </Page>
    </Document>
  )

  const buffer = await renderToBuffer(doc)

  const safeTitle = (title ?? 'essay').replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 100).trim() || 'essay'

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeTitle}.pdf"`,
    },
  })
}
