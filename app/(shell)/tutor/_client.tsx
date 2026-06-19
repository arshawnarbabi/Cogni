'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTheme } from 'next-themes'
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import {
  PaperPlaneRight,
  Microphone,
  ChatCircle,
  Chalkboard,
  Crosshair,
  CircleNotch,
  Plus,
  ArrowsOut,
  Brain,
  Cards,
  Paperclip,
  Globe,
  X,
  Trash,
  CheckCircle,
  WarningCircle,
  MinusCircle,
  PencilSimple,
  Key,
  StackSimple,
  FilePdf,
  FileText,
  FileMd,
  Camera,
} from '@phosphor-icons/react'
import { StaggerList, StaggerItem, ease } from '@/components/ui/motion'
import { resolveIcon, resolveColor } from '@/lib/course-icons'
import { BorderBeam } from 'border-beam'
import { EssayEditor, applyEdit, type AssistanceLevel, type SuggestedEdit } from '@/components/essay/EssayEditor'
import { QuizSession, type QuizQuestion } from '@/components/quiz/QuizSession'
import type { GradeSummary } from '@/lib/agents/practice-quiz'
import { FlashcardViewer } from '@/components/quiz/FlashcardViewer'
import type { Editor } from '@tiptap/react'

type Course = { course_id: string; name: string; icon: string | null; icon_color: string | null; professors: { name: string }[] | { name: string } | null }
type Session = { session_id: string; course_id: string; name: string | null; mode: string; created_at: string; essay_content?: string | null }
type Mode = 'answer' | 'teach' | 'focus' | 'homework'
type InlineCard = { type: 'flashcards' | 'quiz' | 'essay'; count: number; topic: string; data?: object[] }
type InlineChart = {
  chart_type: 'line' | 'bar' | 'pie'
  title: string
  data: { label: string; value: number; value2?: number }[]
  x_label?: string
  y_label?: string
  value_label?: string
  value2_label?: string
}
type LocalAttachment = { name: string; type: string; data: string; preview?: string; source?: 'material' }
type GradeResult = { score: number; rationale: string; topic: string }
type ChatSegment =
  | { kind: 'thinking'; text: string; done: boolean }
  | { kind: 'search'; query: string; done: boolean }
type Message = {
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
  inlineCards?: InlineCard[]
  inlineChart?: InlineChart
  segments?: ChatSegment[]
  grade?: GradeResult
  attachments?: LocalAttachment[]
}
type EssayState = { open: boolean; topic: string }

const MODES: { value: Mode; label: string; Icon: React.ElementType; tip: string; description: string }[] = [
  {
    value: 'answer',
    label: 'Answer',
    Icon: ChatCircle,
    tip: 'Direct, clear answers to your questions.',
    description: 'Answer mode — direct, concise responses to your questions.',
  },
  {
    value: 'teach',
    label: 'Teach',
    Icon: Chalkboard,
    tip: 'Guides you with questions instead of giving answers directly.',
    description: 'Teach mode — Socratic method. Expect questions back, not immediate answers.',
  },
  {
    value: 'focus',
    label: 'Focus',
    Icon: Crosshair,
    tip: 'Steers every response toward your weakest topics.',
    description: 'Focus mode — every response connects back to your weakest areas.',
  },
  {
    value: 'homework',
    label: 'Homework',
    Icon: Camera,
    tip: 'Snap or attach a problem — get coached through it step by step.',
    description: 'Homework mode — attach a photo of the problem and get walked through it, one step at a time. No straight answers.',
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAttachmentMeta(content: string): { names: string[]; text: string } {
  const m = /^\[att:([^\]]+)\]\n/.exec(content)
  if (!m) return { names: [], text: content }
  return { names: m[1].split('|').filter(Boolean), text: content.slice(m[0].length) }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UserBubble({ msg }: { msg: Message }) {
  const { names: loadedNames, text: displayText } = msg.attachments
    ? { names: [], text: msg.content }
    : parseAttachmentMeta(msg.content)

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Live attachment chips (just sent) */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {msg.attachments.map((att, j) => (
            <div key={j} className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1">
              {att.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={att.preview} alt={att.name} className="size-3.5 rounded object-cover" />
              ) : (
                <Paperclip size={11} className="text-muted-foreground" />
              )}
              <span className="max-w-28 truncate text-[10px] text-muted-foreground">{att.name}</span>
            </div>
          ))}
        </div>
      )}
      {/* Placeholder chips for attachments loaded from history */}
      {!msg.attachments && loadedNames.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {loadedNames.map((name, j) => (
            <div key={j} className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1">
              <Paperclip size={11} className="text-muted-foreground" />
              <span className="max-w-28 truncate text-[10px] text-muted-foreground">{name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-sm leading-normal text-primary-foreground">
        {displayText}
      </div>
    </div>
  )
}

function InlineCardChip({ card, onExpand }: { card: InlineCard; onExpand: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.22, ease }}
      className="mt-2 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5"
    >
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
        {card.type === 'essay'
          ? <PencilSimple size={15} className="text-primary" weight="fill" />
          : <Cards size={15} className="text-primary" weight="fill" />
        }
      </div>
      <div className="flex flex-1 flex-col">
        <span className="text-xs font-semibold text-foreground">
          {card.type === 'essay'
            ? `Essay — ${card.topic}`
            : card.type === 'flashcards'
            ? `${card.count} flashcards — ${card.topic}`
            : `Quiz — ${card.topic} (${card.count} questions)`}
        </span>
        <span className="text-[10px] text-muted-foreground">{card.type === 'essay' ? 'Tap to open essay editor' : 'Tap to expand'}</span>
      </div>
      <button
        onClick={onExpand}
        className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
      >
        <ArrowsOut size={13} />
      </button>
    </motion.div>
  )
}

function SystemNotice({ content }: { content: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease }}
      className="flex justify-center"
    >
      <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
        {content}
      </span>
    </motion.div>
  )
}

function ThinkingBlock({ thinking, done }: { thinking: string; done: boolean }) {
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    if (done) setExpanded(false)
  }, [done])

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      className="mb-2 w-fit max-w-xl rounded-xl border border-violet-200/60 bg-violet-50/50 dark:border-violet-800/30 dark:bg-violet-950/20 overflow-hidden"
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 px-3 py-2 text-left"
      >
        {done ? (
          <Brain size={13} className="shrink-0 text-violet-500" weight="fill" />
        ) : (
          <CircleNotch size={13} className="shrink-0 animate-spin text-violet-500" />
        )}
        <span className="flex-1 text-xs font-medium text-violet-700 dark:text-violet-400">
          {done ? 'Thought for a moment' : 'Thinking…'}
        </span>
        <span className="text-[10px] text-violet-400">{expanded ? '▲' : '▼'}</span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && thinking && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease }}
            className="overflow-hidden"
          >
            <div className="max-h-48 overflow-y-auto overscroll-contain px-3 pb-3 font-mono text-[11px] leading-relaxed text-violet-800/70 dark:text-violet-300/60 whitespace-pre-wrap">
              {thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function SearchBlock({ query, done }: { query: string; done: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2"
    >
      <Globe
        size={13}
        weight={done ? 'regular' : 'fill'}
        className={`shrink-0 ${done ? 'text-muted-foreground' : 'text-primary'}`}
      />
      <span className="text-xs text-muted-foreground">
        {done ? 'Searched:' : 'Searching the web for:'}
      </span>
      <span className="flex-1 truncate text-xs font-medium text-foreground">{query}</span>
      {!done && <CircleNotch size={11} className="shrink-0 animate-spin text-muted-foreground" />}
    </motion.div>
  )
}

function GradeBlock({ grade }: { grade: GradeResult }) {
  const pct = Math.round(grade.score * 100)
  const isStrong = grade.score >= 0.7
  const isPartial = grade.score >= 0.4 && grade.score < 0.7
  const Icon = isStrong ? CheckCircle : isPartial ? MinusCircle : WarningCircle
  const colour = isStrong
    ? 'text-green-600 dark:text-green-400'
    : isPartial
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-red-600 dark:text-red-400'
  const bg = isStrong
    ? 'bg-green-50 border-green-200/60 dark:bg-green-950/20 dark:border-green-800/30'
    : isPartial
    ? 'bg-amber-50 border-amber-200/60 dark:bg-amber-950/20 dark:border-amber-800/30'
    : 'bg-red-50 border-red-200/60 dark:bg-red-950/20 dark:border-red-800/30'

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease }}
      className={`mt-2 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${bg}`}
    >
      <Icon size={15} weight="fill" className={`mt-0.5 shrink-0 ${colour}`} />
      <div className="flex flex-col gap-0.5">
        <span className={`text-xs font-semibold ${colour}`}>
          {grade.topic} — {pct}%
        </span>
        <span className="text-xs text-muted-foreground">{grade.rationale}</span>
      </div>
    </motion.div>
  )
}

const CHART_COLORS = ['#1D4ED8', '#F59E0B', '#22C55E', '#EF4444', '#8B5CF6', '#06B6D4']

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // Pin strict mode so model-generated diagram code can't inject script/click handlers
        securityLevel: 'strict',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        fontFamily: 'var(--font-inter), sans-serif',
      })
      return mermaid.render(id, code)
    }).then(({ svg }) => {
      if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg
    }).catch(() => {
      if (!cancelled && containerRef.current) containerRef.current.textContent = code
    })
    return () => { cancelled = true }
  }, [code, resolvedTheme])

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-x-auto rounded-xl border border-border bg-card p-4"
    />
  )
}

function InlineChartBlock({ chart }: { chart: InlineChart }) {
  const hasValue2 = chart.data.some(d => d.value2 !== undefined)
  const rechartData = chart.data.map(d => ({ name: d.label, value: d.value, value2: d.value2 }))
  const v1Name = chart.value_label ?? 'value'
  const v2Name = chart.value2_label ?? 'value2'
  const axisStyle = { fontSize: 10, fill: '#94A3B8' }
  const gridColor = 'rgba(148,163,184,0.2)'
  const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0', padding: '4px 10px' }

  return (
    <div className="mt-3 w-full rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 pt-3 pb-0">
        <p className="text-xs font-semibold text-foreground">{chart.title}</p>
      </div>

      {chart.chart_type === 'pie' ? (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Pie
                data={rechartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={72}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                label={({ name, percent }: any) => `${name ?? ''} ${(((percent as number) ?? 0) * 100).toFixed(0)}%`}
                labelLine={false}
                fontSize={10}
              >
                {rechartData.map((_, idx) => (
                  <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : chart.chart_type === 'line' ? (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rechartData} margin={{ top: 8, right: 16, bottom: chart.x_label ? 28 : 8, left: chart.y_label ? 8 : -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis
                dataKey="name"
                tick={axisStyle}
                label={chart.x_label ? { value: chart.x_label, position: 'insideBottom', offset: -14, style: { fontSize: 10, fill: '#94A3B8' } } : undefined}
              />
              <YAxis
                tick={axisStyle}
                width={40}
                label={chart.y_label ? { value: chart.y_label, angle: -90, position: 'insideLeft', offset: 8, style: { fontSize: 10, fill: '#94A3B8' } } : undefined}
              />
              <Tooltip contentStyle={tooltipStyle} />
              {hasValue2 && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />}
              <Line type="monotone" dataKey="value" name={v1Name} stroke="#1D4ED8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              {hasValue2 && <Line type="monotone" dataKey="value2" name={v2Name} stroke="#F59E0B" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rechartData} margin={{ top: 8, right: 16, bottom: chart.x_label ? 28 : 8, left: chart.y_label ? 8 : -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis
                dataKey="name"
                tick={axisStyle}
                label={chart.x_label ? { value: chart.x_label, position: 'insideBottom', offset: -14, style: { fontSize: 10, fill: '#94A3B8' } } : undefined}
              />
              <YAxis
                tick={axisStyle}
                width={40}
                label={chart.y_label ? { value: chart.y_label, angle: -90, position: 'insideLeft', offset: 8, style: { fontSize: 10, fill: '#94A3B8' } } : undefined}
              />
              <Tooltip contentStyle={tooltipStyle} />
              {hasValue2 && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />}
              <Bar dataKey="value" name={v1Name} fill="#1D4ED8" radius={[4, 4, 0, 0]} maxBarSize={48} />
              {hasValue2 && <Bar dataKey="value2" name={v2Name} fill="#F59E0B" radius={[4, 4, 0, 0]} maxBarSize={48} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  if (streaming && !content) {
    return <CircleNotch size={14} className="animate-spin text-muted-foreground" />
  }

  const fadeMask = streaming
    ? {
        maskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), rgba(0,0,0,0.25) 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), rgba(0,0,0,0.25) 100%)',
      }
    : undefined

  return (
    <div
      style={fadeMask}
      className="prose prose-sm dark:prose-invert max-w-none text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:leading-relaxed prose-li:leading-relaxed prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.8em] prose-code:font-mono prose-code:text-foreground prose-pre:bg-transparent prose-pre:p-0 prose-strong:text-foreground prose-a:text-primary"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '')
            if (!inline && match?.[1] === 'mermaid') {
              return <MermaidDiagram code={String(children).replace(/\n$/, '')} />
            }
            return !inline && match ? (
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                className="!rounded-xl !text-[0.8em]"
                {...props}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            ) : (
              <code className={className} {...props}>{children}</code>
            )
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">{children}</table>
              </div>
            )
          },
          th({ children }) {
            return <th className="border border-border bg-muted px-3 py-1.5 text-left font-semibold">{children}</th>
          },
          td({ children }) {
            return <td className="border border-border px-3 py-1.5">{children}</td>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function MessageSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="flex flex-col gap-6"
    >
      <div className="flex justify-end">
        <div className="h-8 w-40 animate-pulse rounded-2xl bg-muted/70" />
      </div>
      <div className="flex max-w-[75%] flex-col gap-2">
        <div className="h-4 w-3/4 animate-pulse rounded-lg bg-muted/70" />
        <div className="h-4 w-2/3 animate-pulse rounded-lg bg-muted/70" />
        <div className="h-4 w-1/2 animate-pulse rounded-lg bg-muted/70" />
      </div>
      <div className="flex justify-end">
        <div className="h-8 w-28 animate-pulse rounded-2xl bg-muted/70" />
      </div>
      <div className="flex max-w-[75%] flex-col gap-2">
        <div className="h-4 w-4/5 animate-pulse rounded-lg bg-muted/70" />
        <div className="h-4 w-3/5 animate-pulse rounded-lg bg-muted/70" />
      </div>
    </motion.div>
  )
}

// ── File helpers ──────────────────────────────────────────────────────────────

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
  })
}

// ── Materials picker ──────────────────────────────────────────────────────────

type CourseMaterial = { material_id: string; filename: string; tier: number; file_type: string }

function MaterialFilePreview({ fileType }: { fileType: string }) {
  if (fileType === 'pdf') {
    return (
      <div className="flex h-20 w-full items-center justify-center rounded-lg bg-red-500/10 border border-red-500/20">
        <FilePdf size={30} className="text-red-400" weight="fill" />
      </div>
    )
  }
  if (fileType === 'md') {
    return (
      <div className="flex h-20 w-full items-center justify-center rounded-lg bg-blue-500/10 border border-blue-500/20">
        <FileMd size={30} className="text-blue-400" weight="fill" />
      </div>
    )
  }
  return (
    <div className="flex h-20 w-full items-center justify-center rounded-lg bg-muted border border-border">
      <FileText size={30} className="text-muted-foreground" weight="fill" />
    </div>
  )
}

function MaterialsPickerModal({ courseId, onClose, onAttach }: {
  courseId: string
  onClose: () => void
  onAttach: (attachments: LocalAttachment[]) => void
}) {
  const [materials, setMaterials] = useState<CourseMaterial[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/courses/${courseId}/materials`)
      .then(r => r.json())
      .then(d => setMaterials(d.materials ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [courseId])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleAttach() {
    if (selected.size === 0) return
    setAttaching(true)
    setError(null)
    const atts: LocalAttachment[] = []
    for (const id of Array.from(selected)) {
      try {
        const res = await fetch(`/api/courses/${courseId}/material-content?id=${id}`)
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          setError((json as { error?: string }).error ?? `Failed to load material (${res.status})`)
          setAttaching(false)
          return
        }
        const { content, filename } = await res.json()
        if (content) atts.push({ name: filename, type: 'text/plain', data: content, source: 'material' })
      } catch {
        setError('Could not load material content. Try again.')
        setAttaching(false)
        return
      }
    }
    if (atts.length === 0) {
      setError('No content could be extracted from the selected files.')
      setAttaching(false)
      return
    }
    onAttach(atts)
  }

  const TIER_LABEL: Record<number, string> = { 1: 'Syllabus', 2: 'Primary', 3: 'Practice', 4: 'Past exams' }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card shadow-xl flex flex-col overflow-hidden"
        style={{ maxHeight: '75vh' }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <StackSimple size={14} className="text-primary" weight="fill" />
            <span className="text-sm font-semibold text-foreground">Course materials</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground">
            <X size={13} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-4 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <CircleNotch size={18} className="animate-spin text-muted-foreground" />
            </div>
          ) : materials.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No processed materials for this course yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 pb-2">
              {materials.map(mat => {
                const isSelected = selected.has(mat.material_id)
                return (
                  <button
                    key={mat.material_id}
                    onClick={() => toggle(mat.material_id)}
                    className={`relative flex flex-col gap-2 rounded-xl border-2 p-2.5 text-left transition-colors ${
                      isSelected ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80 hover:bg-muted/30'
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary">
                        <CheckCircle size={12} className="text-primary-foreground" weight="fill" />
                      </div>
                    )}
                    <MaterialFilePreview fileType={mat.file_type} />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-xs font-medium text-foreground truncate leading-tight">{mat.filename}</span>
                      <span className="text-[10px] text-muted-foreground">{TIER_LABEL[mat.tier] ?? `Tier ${mat.tier}`}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {error && (
          <div className="mx-4 mb-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
            <span className="text-xs text-destructive">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <span className="text-xs text-muted-foreground">{selected.size} selected</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">Cancel</button>
            <button
              onClick={handleAttach}
              disabled={selected.size === 0 || attaching}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {attaching ? <CircleNotch size={11} className="animate-spin" /> : null}
              {attaching ? 'Loading…' : `Attach${selected.size > 0 ? ` ${selected.size}` : ''}`}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function TutorClient({ courses, sessions: initialSessions, hasApiKey = true }: { courses: Course[]; sessions: Session[]; hasApiKey?: boolean }) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions)
  const [activeCourse, setActiveCourse] = useState<Course | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('answer')
  const [deepThink, setDeepThink] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [rateLimited, setRateLimited] = useState(false)
  const [splitContent, setSplitContent] = useState<InlineCard | null>(null)
  const [splitExpanded, setSplitExpanded] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [essay, setEssay] = useState<EssayState>({ open: false, topic: '' })
  const [essayText, setEssayText] = useState('')
  const [essayHtml, setEssayHtml] = useState('')
  const [essayInitialContent, setEssayInitialContent] = useState<string | undefined>(undefined)
  const [assistance, setAssistance] = useState<AssistanceLevel>('suggest')
  const prevAssistanceRef = useRef<AssistanceLevel>('suggest')
  // Index into messages[] from which to start sending history to the API.
  // On essay mode switch, advances to current message count so prior turns aren't sent.
  const historyCutoffRef = useRef(0)
  // Monotonic id per loadSession call — lets a stale fetch detect that a newer
  // session was loaded (or a course selected) and discard its results.
  const loadSeqRef = useRef(0)

  function handleAssistanceChange(v: AssistanceLevel) {
    if (v !== prevAssistanceRef.current) {
      prevAssistanceRef.current = v
      // Clear history context for the new mode — set cutoff to current message count.
      // The chat display is unaffected; only what gets sent to the API changes.
      setMessages(prev => {
        historyCutoffRef.current = prev.length
        return prev
      })
    }
    setAssistance(v)
  }
  // chatPct: percentage of horizontal space the chat panel takes in essay split
  const [chatPct, setChatPct] = useState(25)
  const [isDragging, setIsDragging] = useState(false)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  // cardChatPct: percentage of horizontal space the chat panel takes in flashcard/quiz split
  const [cardChatPct, setCardChatPct] = useState(38)
  const [cardIsDragging, setCardIsDragging] = useState(false)
  const cardSplitContainerRef = useRef<HTMLDivElement>(null)
  const essayEditorRef = useRef<Editor | null>(null)
  const essaySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forceNewRef = useRef(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const optionsPanelRef = useRef<HTMLDivElement>(null)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const inputBarRef = useRef<HTMLDivElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [showMaterialsPicker, setShowMaterialsPicker] = useState(false)

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Debounced essay autosave
  useEffect(() => {
    if (!essay.open || !activeSessionId || !essayHtml) return
    if (essaySaveTimerRef.current) clearTimeout(essaySaveTimerRef.current)
    essaySaveTimerRef.current = setTimeout(() => {
      fetch(`/api/agents/tutor/sessions?sessionId=${activeSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ essay_content: essayHtml }),
      }).catch(() => {})
    }, 1500)
    return () => {
      if (essaySaveTimerRef.current) clearTimeout(essaySaveTimerRef.current)
    }
  }, [essayHtml, essay.open, activeSessionId])

  // Essay split drag-to-resize
  function handleDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    setIsDragging(true)
    function onMove(ev: MouseEvent) {
      if (!splitContainerRef.current) return
      const rect = splitContainerRef.current.getBoundingClientRect()
      const pct = Math.round(((ev.clientX - rect.left) / rect.width) * 100)
      setChatPct(Math.max(20, Math.min(75, pct)))
    }
    function onUp() {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function handleCardDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    setCardIsDragging(true)
    function onMove(ev: MouseEvent) {
      if (!cardSplitContainerRef.current) return
      const rect = cardSplitContainerRef.current.getBoundingClientRect()
      const pct = Math.round(((ev.clientX - rect.left) / rect.width) * 100)
      setCardChatPct(Math.max(20, Math.min(75, pct)))
    }
    function onUp() {
      setCardIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Close options panel on any click outside the panel itself or the plus button.
  // Clicking the textarea / other input-bar buttons should close the menu.
  useEffect(() => {
    if (!showOptions) return
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (optionsPanelRef.current?.contains(target)) return
      if (plusBtnRef.current?.contains(target)) return
      setShowOptions(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showOptions])

  // Auto-grow textarea (state-driven so CSS transitions fire smoothly)
  const [taHeight, setTaHeight] = useState(24)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const prev = el.style.height
    el.style.height = 'auto'
    const h = Math.min(Math.max(el.scrollHeight, 24), 160)
    el.style.height = prev
    setTaHeight(h)
  }, [input])

  async function handleFiles(files: FileList) {
    const newAtts: LocalAttachment[] = []
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const data = await readAsBase64(file)
        const preview = URL.createObjectURL(file)
        newAtts.push({ name: file.name, type: file.type, data, preview })
      } else if (
        file.type.startsWith('text/') ||
        /\.(txt|md|py|js|ts|json|csv|html|css)$/.test(file.name)
      ) {
        const data = await file.text()
        newAtts.push({ name: file.name, type: 'text/plain', data })
      }
    }
    setAttachments(prev => [...prev, ...newAtts])
  }

  function removeAttachment(i: number) {
    setAttachments(prev => {
      const next = [...prev]
      if (next[i].preview) URL.revokeObjectURL(next[i].preview!)
      next.splice(i, 1)
      return next
    })
  }

  async function deleteSession(sessionId: string) {
    try {
      await fetch(`/api/agents/tutor/sessions?sessionId=${sessionId}`, { method: 'DELETE' })
    } catch { /* non-critical */ }
    setSessions(prev => prev.filter(s => s.session_id !== sessionId))
    // If the deleted session is currently active, return to course picker
    if (activeSessionId === sessionId) {
      loadSeqRef.current++ // invalidate any in-flight loadSession fetch
      setActiveCourse(null)
      setActiveSessionId(null)
      setMessages([])
      setAttachments([])
      setSplitContent(null)
      setSplitExpanded(false)
      setEssay({ open: false, topic: '' })
      setEssayText('')
      setEssayHtml('')
    }
  }

  function changeMode(newMode: Mode) {
    if (newMode === mode) return
    setMode(newMode)
    const def = MODES.find(m => m.value === newMode)
    if (def && activeCourse) {
      setMessages(prev => [...prev, { role: 'system', content: def.description }])
    }
  }

  function selectCourse(course: Course) {
    loadSeqRef.current++ // invalidate any in-flight loadSession fetch
    setActiveCourse(course)
    setActiveSessionId(null)
    setMessages([{ role: 'system', content: MODES.find(m => m.value === mode)!.description }])
    setInput('')
    setAttachments([])
    setSplitContent(null)
    setSplitExpanded(false)
    setEssay({ open: false, topic: '' })
    setEssayText('')
    setEssayHtml('')
    setLoadingMessages(false)
    // Fresh conversation — a cutoff carried over from a previous session would
    // silently truncate the history sent to the API.
    historyCutoffRef.current = 0
    prevAssistanceRef.current = assistance
    forceNewRef.current = false
  }

  function startNewSession(course: Course) {
    selectCourse(course)
    forceNewRef.current = true
  }

  async function refreshSessions() {
    try {
      const res = await fetch('/api/agents/tutor/sessions')
      if (res.ok) {
        const { sessions: fresh } = await res.json() as { sessions: Session[] }
        setSessions(fresh)
      }
    } catch {
      // non-critical
    }
  }

  async function loadSession(session: Session) {
    const course = courses.find(c => c.course_id === session.course_id)
    if (!course) return
    // Capture a fresh sequence id; if another load (or course select) starts
    // before our fetch resolves, we bail instead of applying stale messages.
    const seq = ++loadSeqRef.current
    setActiveCourse(course)
    setActiveSessionId(session.session_id)
    setMode(session.mode as Mode)
    setMessages([])
    setAttachments([])
    setSplitContent(null)
    setSplitExpanded(false)
    setLoadingMessages(true)
    // Reset per-session history cutoff — see selectCourse.
    historyCutoffRef.current = 0
    prevAssistanceRef.current = assistance
    if (session.essay_content) {
      setEssayInitialContent(session.essay_content)
      setEssayText(session.essay_content)
      setEssay({ open: true, topic: session.name ?? '' })
    } else {
      setEssay({ open: false, topic: '' })
      setEssayText('')
      setEssayHtml('')
      setEssayInitialContent(undefined)
    }

    // Fetch stored messages for this session
    try {
      const res = await fetch(`/api/agents/tutor?sessionId=${session.session_id}`)
      if (res.ok) {
        const { messages: stored } = await res.json() as {
          messages: { role: string; content: string; inline_card?: InlineCard | InlineCard[] | null }[]
        }
        // A newer session was loaded while we awaited — discard this response
        if (seq !== loadSeqRef.current) return
        const restored = stored.map(m => {
          const base: Message = { role: m.role as Message['role'], content: m.content }
          if (m.inline_card) {
            const cards = Array.isArray(m.inline_card) ? m.inline_card : [m.inline_card]
            base.inlineCards = cards
            // Re-open essay mode if the last message has an essay card
            if (m === stored[stored.length - 1]) {
              const essayCard = cards.find(c => c.type === 'essay')
              if (essayCard) setEssay({ open: true, topic: essayCard.topic })
            }
          }
          return base
        })
        setMessages(restored)
        // Restore the last non-essay artifact in the split panel if present
        const lastCard = restored
          .slice()
          .reverse()
          .flatMap(m => (m.inlineCards ?? []).slice().reverse())
          .find(c => c.type !== 'essay')
        if (lastCard) setSplitContent(lastCard)
      }
    } catch {
      // non-critical — leave messages empty
    } finally {
      // Only the most recent load may clear the skeleton
      if (seq === loadSeqRef.current) setLoadingMessages(false)
    }
  }

  async function sendMessage(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    if (!text || !activeCourse || sending || rateLimited) return
    const sentAttachments = textOverride ? [] : [...attachments]
    if (!textOverride) {
      setInput('')
      setAttachments([])
      setTaHeight(24)
    }
    setSending(true)

    const userMsg: Message = { role: 'user', content: text, attachments: sentAttachments }
    const assistantMsg: Message = { role: 'assistant', content: '', streaming: true }
    setMessages(prev => [...prev, userMsg, assistantMsg])

    const wasForceNew = forceNewRef.current
    forceNewRef.current = false

    try {
      const res = await fetch('/api/agents/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: activeCourse.course_id,
          courseName: activeCourse.name,
          message: text,
          mode,
          deepThink,
          sessionId: activeSessionId,
          forceNew: wasForceNew,
          attachments: sentAttachments.map(a => ({ name: a.name, type: a.type, data: a.data })),
          essayContent: essay.open ? essayText : undefined,
          assistanceLevel: essay.open ? assistance : undefined,
          historyCutoff: essay.open ? historyCutoffRef.current : 0,
        }),
      })

      if (!res.ok) {
        // Tolerate non-JSON error bodies (e.g. proxy HTML) — the catch below
        // would otherwise eat the real status.
        const err = await res.json().catch(() => ({} as { error?: string }))
        if (res.status === 429 && err.error === 'rate_limited') {
          setMessages(prev => prev.slice(0, -2))
          setInput(text)
          // Restore attachments too — they were cleared optimistically on send
          if (!textOverride) setAttachments(sentAttachments)
          setRateLimited(true)
          return
        }
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: `Error: ${err.error ?? 'Something went wrong'}` }
          return updated
        })
        return
      }

      const newSessionId = res.headers.get('X-Session-Id')
      if (newSessionId && !activeSessionId) {
        setActiveSessionId(newSessionId)
        refreshSessions()
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let lineBuffer = ''
      let accumulated = ''
      const segments: ChatSegment[] = []
      const cardPayloads: InlineCard[] = []
      let gradeResult: GradeResult | undefined
      let errored = false

      // Helpers — mutate in place, then push a new snapshot to React state
      function updateLastOfKind<K extends ChatSegment['kind']>(
        kind: K,
        mutator: (seg: Extract<ChatSegment, { kind: K }>) => void,
      ) {
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].kind === kind) {
            mutator(segments[i] as Extract<ChatSegment, { kind: K }>)
            return
          }
        }
      }
      function syncSegments() {
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            segments: segments.map(s => ({ ...s })),
          }
          return updated
        })
      }

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line) as {
                t: string; c?: string; q?: string
                kind?: 'flashcards' | 'quiz'; topic?: string; count?: number; data?: object[]
                score?: number; rationale?: string
                target?: string; replacement?: string; instruction?: string
                chart_type?: string; title?: string; x_label?: string; y_label?: string
                value_label?: string; value2_label?: string
              }

              if (event.t === 'text' && event.c) {
                accumulated += event.c
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    role: 'assistant',
                    content: accumulated,
                    streaming: true,
                    grade: gradeResult,
                  }
                  return updated
                })
              } else if (event.t === 'think_start') {
                segments.push({ kind: 'thinking', text: '', done: false })
                syncSegments()
              } else if (event.t === 'think_delta' && event.c) {
                updateLastOfKind('thinking', s => { s.text += event.c! })
                syncSegments()
              } else if (event.t === 'think_stop') {
                updateLastOfKind('thinking', s => { s.done = true })
                syncSegments()
              } else if (event.t === 'search_start') {
                segments.push({ kind: 'search', query: '', done: false })
                syncSegments()
              } else if (event.t === 'search_done') {
                updateLastOfKind('search', s => {
                  s.query = event.q ?? ''
                  s.done = true
                })
                syncSegments()
              } else if (event.t === 'card' && event.kind) {
                const newCard: InlineCard = {
                  type: event.kind,
                  count: event.count ?? 0,
                  topic: event.topic ?? '',
                  data: event.data,
                }
                cardPayloads.push(newCard)
                const snapshot = [...cardPayloads]
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    inlineCards: snapshot,
                  }
                  return updated
                })
                setSplitContent(newCard)
              } else if (event.t === 'essay_open' && event.topic) {
                const topic = event.topic
                setEssay({ open: true, topic })
                setChatPct(25)
                cardPayloads.push({ type: 'essay', topic, count: 0 })
                const snapshot = [...cardPayloads]
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    inlineCards: snapshot,
                  }
                  return updated
                })
              } else if (event.t === 'essay_edit') {
                const edit: SuggestedEdit = {
                  target: event.target ?? '',
                  replacement: event.replacement ?? '',
                }
                if (essayEditorRef.current) {
                  applyEdit(essayEditorRef.current, edit)
                }
              } else if (event.t === 'grade' && event.score !== undefined) {
                gradeResult = {
                  score: event.score,
                  rationale: event.rationale ?? '',
                  topic: event.topic ?? '',
                }
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    grade: gradeResult,
                  }
                  return updated
                })
              } else if (event.t === 'chart' && event.chart_type) {
                const chart: InlineChart = {
                  chart_type: event.chart_type as 'line' | 'bar' | 'pie',
                  title: event.title ?? '',
                  data: (event.data as { label: string; value: number; value2?: number }[]) ?? [],
                  x_label: event.x_label,
                  y_label: event.y_label,
                  value_label: event.value_label,
                  value2_label: event.value2_label,
                }
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    inlineChart: chart,
                  }
                  return updated
                })
              } else if (event.t === 'error') {
                errored = true
                const errMsg = event.c ?? 'Something went wrong'
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = { role: 'assistant', content: `Error: ${errMsg}` }
                  return updated
                })
              }
            } catch {
              // non-JSON line, ignore
            }
          }
        }
      }

      if (!errored) {
        // Make sure any segments still marked in-progress get closed out
        segments.forEach(s => { s.done = true })
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          updated[updated.length - 1] = {
            role: 'assistant',
            content: accumulated,
            segments: segments.length > 0 ? segments.map(s => ({ ...s })) : undefined,
            inlineCards: cardPayloads.length > 0 ? cardPayloads : undefined,
            inlineChart: last.inlineChart,
            grade: gradeResult,
          }
          return updated
        })
      }
    } catch {
      // Network drop or mid-stream failure — replace the streaming placeholder
      // with an error bubble so the spinner never spins forever, and restore
      // the user's input so they can retry.
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'assistant', content: 'Error: connection lost — please try again.' }
        return updated
      })
      if (!textOverride) setInput(text)
    } finally {
      setSending(false)
    }
  }

  function handleFlashcardComplete(summary: { total: number; again: number; hard: number; good: number; easy: number }) {
    const topic = splitContent?.topic ?? 'the flashcards'
    const parts: string[] = []
    if (summary.again > 0) parts.push(`Again ×${summary.again}`)
    if (summary.hard > 0) parts.push(`Hard ×${summary.hard}`)
    if (summary.good > 0) parts.push(`Good ×${summary.good}`)
    if (summary.easy > 0) parts.push(`Easy ×${summary.easy}`)
    const ratingStr = parts.length > 0 ? ` My ratings: ${parts.join(', ')}.` : ''
    const text = `I just finished reviewing ${summary.total} flashcards on ${topic}.${ratingStr} Can you give me a quick summary of how I did and what to focus on next?`
    sendMessage(text)
  }

  function handleQuizComplete(summary: GradeSummary) {
    const topic = splitContent?.topic ?? 'the quiz'
    const total = splitContent?.count ?? summary.correctCount
    const allCorrect = total > 0 && summary.correctCount === total
    const missedParts = allCorrect
      ? ' I got everything right.'
      : summary.missedTopics.length > 0
      ? ` I struggled most with: ${summary.missedTopics.map(t => `${t.topic} (${t.wrongCount} wrong)`).join(', ')}.`
      : ''
    const breakdown = summary.results.length > 0
      ? '\n\nQuestion-by-question:\n' + summary.results.map((r, i) => {
          const q = r.question.question.replace(/\s+/g, ' ').trim()
          const mark = r.correct ? '✓' : '✗'
          const userLine = r.userAnswer ? `  My answer: ${r.userAnswer}` : '  My answer: (blank)'
          const correctLine = r.correct ? '' : `\n  Correct: ${r.question.answer}`
          return `${i + 1}. ${mark} ${q}\n${userLine}${correctLine}`
        }).join('\n')
      : ''
    const text = `I just finished the quiz on ${topic}. I got ${summary.correctCount} out of ${total} correct (${Math.round(summary.scorePct)}%).${missedParts} Can you review my results and help me understand what to work on?${breakdown}`
    sendMessage(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter') return
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      setInput(prev => prev.slice(0, start) + '\n' + prev.slice(end))
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1
      })
    } else if (!e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleCopyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  const handleExportTxt = useCallback((text: string) => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${essay.topic || 'essay'}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [essay.topic])

  const handleExportMd = useCallback((text: string) => {
    const blob = new Blob([text], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${essay.topic || 'essay'}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [essay.topic])

  const handleExportDocx = useCallback(async (html: string) => {
    const res = await fetch('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, title: essay.topic || 'Essay' }),
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${essay.topic || 'essay'}.docx`
    a.click()
    URL.revokeObjectURL(url)
  }, [essay.topic])

  const handleExportPdf = useCallback(async (html: string) => {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, title: essay.topic || 'Essay' }),
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${essay.topic || 'essay'}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }, [essay.topic])

  function startVoice() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!SR) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new SR() as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => setInput((p: string) => p + e.results[0][0].transcript)
    rec.start()
  }

  // ── Course picker ─────────────────────────────────────────────────────────
  if (!activeCourse) {
    return (
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain min-h-0 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Tutor</h1>
          <p className="mt-1 text-sm text-muted-foreground">Pick a course to start a session.</p>
        </div>

        {!hasApiKey && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/40 dark:bg-amber-950/20">
            <Key size={14} className="shrink-0 text-amber-600 dark:text-amber-400" weight="fill" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              No Anthropic API key set — add one in{' '}
              <a href="/settings" className="underline underline-offset-2">Settings</a> to use the Tutor.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground">Your courses</p>
          {courses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No courses yet.</p>
          ) : (
            <StaggerList className="flex flex-col gap-2">
              {courses.map(course => {
                const CourseIcon = resolveIcon(course.icon)
                const palette = resolveColor(course.icon_color)
                return (
                  <StaggerItem key={course.course_id}>
                    <motion.button
                      onClick={() => selectCourse(course)}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                      whileTap={{ scale: 0.99 }}
                      transition={{ duration: 0.1 }}
                    >
                      <div className={`flex size-9 items-center justify-center rounded-lg ${palette.bg}`}>
                        <CourseIcon size={16} className={palette.icon} weight="fill" />
                      </div>
                      <span className="text-sm font-medium text-foreground">{course.name}</span>
                    </motion.button>
                  </StaggerItem>
                )
              })}
            </StaggerList>
          )}
        </div>

        {sessions.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-muted-foreground">Recent sessions</p>
            <StaggerList className="flex flex-col gap-2">
              {sessions.slice(0, 5).map(session => (
                <StaggerItem key={session.session_id}>
                  <div className="group flex items-center gap-2 rounded-xl border border-border bg-card hover:bg-muted/30 transition-colors">
                    <button
                      onClick={() => loadSession(session)}
                      className="flex flex-1 items-center gap-3 px-4 py-3 text-left min-w-0"
                    >
                      <ChatCircle size={16} className="shrink-0 text-muted-foreground" />
                      <div className="flex flex-1 flex-col min-w-0">
                        <span className="truncate text-sm text-foreground">{session.name ?? 'Unnamed session'}</span>
                        <span className="text-xs text-muted-foreground">
                          {courses.find(c => c.course_id === session.course_id)?.name ?? ''}
                        </span>
                      </div>
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteSession(session.session_id) }}
                      className="mr-2 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 transition-all"
                      aria-label="Delete session"
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                </StaggerItem>
              ))}
            </StaggerList>
          </div>
        )}
      </div>
    )
  }

  // ── Chat panel (shared between regular and essay layouts) ────────────────
  const chatPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setActiveCourse(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              ← Courses
            </button>
            <span className="truncate text-sm font-semibold text-foreground">{activeCourse.name}</span>
          </div>
          {essay.open ? (
            <span className="justify-self-center flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary">
              <PencilSimple size={11} weight="fill" />
              Essay Mode
            </span>
          ) : (() => {
            const m = MODES.find(m => m.value === mode)!
            return (
              <span className="justify-self-center rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
                {m.label} Mode
              </span>
            )
          })()}
          <div className="flex items-center gap-2 justify-self-end">
            {activeSessionId && (
              <button
                onClick={() => deleteSession(activeSessionId)}
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 transition-colors"
                aria-label="Delete session"
              >
                <Trash size={14} />
              </button>
            )}
            <button
              onClick={() => startNewSession(activeCourse)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus size={12} weight="bold" />
              New
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={messagesRef} className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain min-h-0 px-10 py-6">
          {loadingMessages ? (
            <MessageSkeleton />
          ) : messages.length === 0 ? (
            (() => {
              const EmptyIcon = resolveIcon(activeCourse.icon)
              const emptyPalette = resolveColor(activeCourse.icon_color)
              return (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center"
                >
                  <EmptyIcon size={32} className={`opacity-60 ${emptyPalette.icon}`} weight="fill" />
                  <p className="text-sm text-muted-foreground">Ask anything about {activeCourse.name}.</p>
                </motion.div>
              )
            })()
          ) : null}

          <AnimatePresence initial={false}>
            {messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 280, damping: 28, mass: 0.9 }}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : msg.role === 'system' ? 'items-center' : 'items-start'
                }`}
              >
                {msg.role === 'system' ? (
                  <SystemNotice content={msg.content} />
                ) : msg.role === 'user' ? (
                  <UserBubble msg={msg} />
                ) : (
                  /* Assistant message */
                  <div className="flex w-full flex-col items-start gap-2">
                    {msg.segments?.map((seg, j) =>
                      seg.kind === 'thinking' ? (
                        <ThinkingBlock key={j} thinking={seg.text} done={seg.done} />
                      ) : (
                        <SearchBlock key={j} query={seg.query} done={seg.done} />
                      )
                    )}
                    {/* Show bubble when content exists OR no segments present */}
                    {(msg.content || !msg.segments || msg.segments.length === 0) && (
                      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-3">
                        <AssistantMessage
                          content={msg.content}
                          streaming={msg.streaming && !msg.segments?.some(s => !s.done)}
                        />
                      </div>
                    )}
                    {msg.inlineChart && (
                      <InlineChartBlock chart={msg.inlineChart} />
                    )}
                    {msg.inlineCards?.map((card, ci) => (
                      <InlineCardChip
                        key={ci}
                        card={card}
                        onExpand={() => {
                          if (card.type === 'essay') {
                            setEssay(prev => ({ ...prev, open: true }))
                            setChatPct(35)
                          } else {
                            setSplitContent(card)
                            setSplitExpanded(true)
                          }
                        }}
                      />
                    ))}
                    {msg.grade && (
                      <GradeBlock grade={msg.grade} />
                    )}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Prompt bar — sticky at bottom */}
        <div className="flex flex-col items-center px-4 pb-4 pt-2 bg-background border-t border-transparent">
          <div className="w-full max-w-2xl">

            {/* Attached file chips */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((att, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs">
                    {att.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={att.preview} alt={att.name} className="size-4 rounded object-cover" />
                    ) : att.source === 'material' ? (
                      <StackSimple size={12} className="text-primary shrink-0" weight="fill" />
                    ) : (
                      <Paperclip size={12} className="text-muted-foreground" />
                    )}
                    <span className="max-w-28 truncate text-foreground">{att.name}</span>
                    <button onClick={() => removeAttachment(i)} aria-label="Remove attachment" className="text-muted-foreground hover:text-foreground transition-colors">
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input bar wrapper — relative so options panel can float above */}
            <div className="relative" ref={inputWrapperRef}>
              {/* Options panel — absolute, floats above input bar */}
              <AnimatePresence>
                {showOptions && (
                  <motion.div
                    ref={optionsPanelRef}
                    initial={{ opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.97 }}
                    transition={{ duration: 0.18, ease }}
                    className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-2xl border border-border bg-card p-4 shadow-lg"
                  >
                    {/* Deep Think row */}
                    <button
                      onClick={() => setDeepThink(p => !p)}
                      className="flex w-full items-center justify-between rounded-xl px-1 py-1 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex size-8 items-center justify-center rounded-lg transition-colors ${deepThink ? 'bg-violet-100 dark:bg-violet-950' : 'bg-muted'}`}>
                          <Brain
                            size={15}
                            weight={deepThink ? 'fill' : 'regular'}
                            className={deepThink ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground'}
                          />
                        </div>
                        <div className="flex flex-col items-start">
                          <span className="text-sm font-medium text-foreground">Deep Think</span>
                          <span className="text-[11px] text-muted-foreground">Uses Opus 4.8 — slower but more thorough</span>
                        </div>
                      </div>
                      <div className={`h-5 w-9 rounded-full transition-colors ${deepThink ? 'bg-violet-500' : 'bg-muted-foreground/30'}`}>
                        <div className={`mt-0.5 size-4 rounded-full bg-background shadow transition-transform ${deepThink ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </div>
                    </button>

                    {/* Course Materials */}
                    <button
                      onClick={() => { setShowMaterialsPicker(true); setShowOptions(false) }}
                      className="mt-1 flex w-full items-center justify-between rounded-xl px-1 py-1 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
                          <StackSimple size={15} weight="fill" className="text-muted-foreground" />
                        </div>
                        <div className="flex flex-col items-start">
                          <span className="text-sm font-medium text-foreground">Course Materials</span>
                          <span className="text-[11px] text-muted-foreground">Inject full content of an uploaded file</span>
                        </div>
                      </div>
                    </button>

                    {!essay.open && <div className="my-3 h-px bg-border" />}

                    {!essay.open && <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">Mode</p>}
                    {!essay.open && (
                      <div className="flex flex-col gap-1">
                        {MODES.map(m => (
                          <button
                            key={m.value}
                            onClick={() => { changeMode(m.value); setShowOptions(false) }}
                            className={`flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors ${
                              mode === m.value ? 'bg-primary/10' : 'hover:bg-muted/40'
                            }`}
                          >
                            <div className={`flex size-7 items-center justify-center rounded-lg ${mode === m.value ? 'bg-primary/10' : 'bg-muted'}`}>
                              <m.Icon
                                size={13}
                                weight={mode === m.value ? 'fill' : 'regular'}
                                className={mode === m.value ? 'text-primary' : 'text-muted-foreground'}
                              />
                            </div>
                            <div className="flex flex-col">
                              <span className={`text-xs font-semibold ${mode === m.value ? 'text-primary' : 'text-foreground'}`}>{m.label}</span>
                              <span className="text-[11px] text-muted-foreground">{m.tip}</span>
                            </div>
                            {mode === m.value && <div className="ml-auto size-2 rounded-full bg-primary" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Input bar */}
              <BorderBeam
                size="md"
                colorVariant="ocean"
                duration={1.96}
                strength={0.5}
                active={deepThink}
              >
              <div
                ref={inputBarRef}
                onDragEnter={e => {
                  if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault()
                    setDragActive(true)
                  }
                }}
                onDragOver={e => {
                  if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }
                }}
                onDragLeave={e => {
                  if (!inputBarRef.current?.contains(e.relatedTarget as Node)) {
                    setDragActive(false)
                  }
                }}
                onDrop={e => {
                  if (e.dataTransfer.files.length > 0) {
                    e.preventDefault()
                    setDragActive(false)
                    handleFiles(e.dataTransfer.files)
                  }
                }}
                className={`flex items-center gap-2 rounded-2xl border bg-card px-4 py-3 shadow-sm transition-colors ${
                  dragActive ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                {/* Left controls — plus and paperclip grouped */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    ref={plusBtnRef}
                    onClick={() => setShowOptions(p => !p)}
                    aria-label="Options"
                    className={`flex size-8 items-center justify-center rounded-lg transition-colors ${
                      showOptions ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    }`}
                  >
                    <Plus size={16} weight={showOptions ? 'bold' : 'regular'} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.txt,.md,.py,.js,.ts,.json,.csv,.html,.css"
                    className="hidden"
                    onChange={async e => {
                      const files = e.target.files
                      if (files && files.length > 0) await handleFiles(files)
                      e.target.value = ''
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach file"
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                  >
                    <Paperclip size={16} />
                  </button>
                </div>

                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={e => {
                    const files: File[] = []
                    for (const item of Array.from(e.clipboardData.items)) {
                      if (item.kind === 'file') {
                        const f = item.getAsFile()
                        if (f) files.push(f)
                      }
                    }
                    if (files.length > 0) {
                      e.preventDefault()
                      const dt = new DataTransfer()
                      files.forEach(f => dt.items.add(f))
                      handleFiles(dt.files)
                    }
                  }}
                  placeholder={`Ask about ${activeCourse.name}…`}
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-[15px] leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none overflow-y-auto overscroll-contain"
                  style={{
                    height: taHeight,
                    transition: 'height 160ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                />

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={startVoice}
                    aria-label="Voice input"
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                  >
                    <Microphone size={16} />
                  </button>
                  <button
                    onClick={() => sendMessage()}
                    disabled={!input.trim() || sending || rateLimited}
                    aria-label="Send message"
                    className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors"
                  >
                    {sending
                      ? <CircleNotch size={15} className="animate-spin" />
                      : <PaperPlaneRight size={15} weight="fill" />
                    }
                  </button>
                </div>
              </div>
              </BorderBeam>
            </div>
          </div>
        </div>
    </div>
  )

  // Rate-limit modal — shared by both layouts so essay mode isn't left with a
  // silently disabled send button when the daily limit is hit.
  const rateLimitedModal = (
    <AnimatePresence>
      {rateLimited && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mx-4 flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-xl"
          >
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-foreground">Daily limit reached</p>
              <p className="text-xs text-muted-foreground">
                You&apos;ve hit your daily message limit for Tutor. Your limit resets at midnight. You can adjust it in{' '}
                <a href="/settings" className="text-primary underline-offset-2 hover:underline">Settings → AI &amp; API Keys</a>.
              </p>
            </div>
            <button
              onClick={() => setRateLimited(false)}
              className="self-end rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground"
            >
              Got it
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // ── Active session ────────────────────────────────────────────────────────
  // Essay mode: custom animated + draggable split
  if (essay.open) {
    const essayPct = 100 - chatPct
    const noTransition = isDragging ? 'none' : 'width 380ms cubic-bezier(0.22, 1, 0.36, 1)'
    return (
      <>
        <div
          ref={splitContainerRef}
          className={`flex h-full overflow-hidden${isDragging ? ' select-none cursor-col-resize' : ''}`}
        >
          {/* Chat panel — animates from 100% → chatPct% on first open */}
          <motion.div
            className="flex flex-col overflow-hidden"
            initial={{ width: '100%' }}
            animate={{ width: `${chatPct}%` }}
            transition={{ duration: isDragging ? 0 : 0.38, ease: [0.22, 1, 0.36, 1] }}
            style={{ minWidth: 0, flexShrink: 0 }}
          >
            {chatPanel}
          </motion.div>

          {/* Draggable divider */}
          <div
            className="w-1 shrink-0 bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors cursor-col-resize"
            style={{ transition: noTransition === 'none' ? 'none' : undefined }}
            onMouseDown={handleDividerMouseDown}
          />

          {/* Essay panel — slides in from right */}
          <motion.div
            className="flex flex-col overflow-hidden"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: `${essayPct}%`, opacity: 1 }}
            transition={{ duration: isDragging ? 0 : 0.38, ease: [0.22, 1, 0.36, 1] }}
            style={{ minWidth: 0 }}
          >
            <EssayEditor
              key={essayInitialContent ?? 'new'}
              initialContent={essayInitialContent}
              assistance={assistance}
              onAssistanceChange={handleAssistanceChange}
              onContentChange={(text, html) => { setEssayText(text); setEssayHtml(html) }}
              onCopyToClipboard={handleCopyToClipboard}
              onExportTxt={handleExportTxt}
              onExportMd={handleExportMd}
              onExportDocx={handleExportDocx}
              onExportPdf={handleExportPdf}
              onClose={() => setEssay(prev => ({ ...prev, open: false }))}
              editorRef={e => { essayEditorRef.current = e }}
            />
          </motion.div>
        </div>
        <AnimatePresence>
          {showMaterialsPicker && (
            <MaterialsPickerModal
              courseId={activeCourse.course_id}
              onClose={() => setShowMaterialsPicker(false)}
              onAttach={atts => { setAttachments(prev => [...prev, ...atts]); setShowMaterialsPicker(false) }}
            />
          )}
        </AnimatePresence>
        {rateLimitedModal}
      </>
    )
  }

  // Regular mode: flashcard/quiz split with draggable divider
  return (
    <>
    <div
      ref={cardSplitContainerRef}
      className={`flex h-full overflow-hidden${cardIsDragging ? ' select-none cursor-col-resize' : ''}`}
    >
      <motion.div
        className="flex h-full min-h-0 flex-col overflow-hidden"
        animate={{ width: splitExpanded ? `${cardChatPct}%` : '100%' }}
        transition={{ duration: cardIsDragging ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
        style={{ minWidth: 0, flexShrink: 0 }}
      >
        {chatPanel}
      </motion.div>

      {/* Draggable divider */}
      {splitExpanded && (
        <div
          className="w-1 shrink-0 bg-border hover:bg-primary/40 cursor-col-resize transition-colors"
          onMouseDown={handleCardDividerMouseDown}
        />
      )}

      {/* Flashcard / quiz split panel */}
      <AnimatePresence>
        {splitExpanded && splitContent && (
          <motion.div
            key="split"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: `${100 - cardChatPct}%` }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: cardIsDragging ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col border-l border-border overflow-hidden"
            style={{ minWidth: 0 }}
          >
            {splitContent.type === 'quiz' && splitContent.data && activeCourse ? (
              <QuizSession
                courseId={activeCourse.course_id}
                courseName={activeCourse.name}
                initialQuestions={splitContent.data as QuizQuestion[]}
                onClose={() => setSplitExpanded(false)}
                onComplete={handleQuizComplete}
              />
            ) : splitContent.type === 'flashcards' && splitContent.data ? (
              <FlashcardViewer
                cards={splitContent.data as { front: string; back: string; card_id?: string }[]}
                topic={splitContent.topic}
                onClose={() => setSplitExpanded(false)}
                onComplete={handleFlashcardComplete}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10">
                  <Cards size={28} className="text-primary" weight="fill" />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {splitContent.count} {splitContent.type === 'flashcards' ? 'flashcards' : 'questions'} ready
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    <AnimatePresence>
      {showMaterialsPicker && (
        <MaterialsPickerModal
          courseId={activeCourse.course_id}
          onClose={() => setShowMaterialsPicker(false)}
          onAttach={atts => { setAttachments(prev => [...prev, ...atts]); setShowMaterialsPicker(false) }}
        />
      )}
    </AnimatePresence>
    {rateLimitedModal}
    </>
  )
}
