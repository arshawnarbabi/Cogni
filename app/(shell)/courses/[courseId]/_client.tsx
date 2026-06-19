'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft,
  Cards,
  Lightning,
  CircleNotch,
  ClipboardText,
  GraduationCap,
  Archive,
  FilePdf,
  FileText,
  Image as ImageIcon,
  Keyboard,
  CaretDown,
  CaretUp,
  User,
  X,
  Trash,
  ArrowRight,
  UploadSimple,
  Check,
  Waveform,
  Play,
  Pause,
  DownloadSimple,
  Globe,
  CheckCircle,
  Exam,
  PencilSimple,
} from '@phosphor-icons/react'
import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { StaggerList, StaggerItem } from '@/components/ui/motion'
import { resolveIcon, resolveColor } from '@/lib/course-icons'
import { QuizSession } from '@/components/quiz/QuizSession'

type Topic = {
  topic_id: string
  name: string
  syllabus_order: number | null
  content_coverage: number
  professor_weight: number
  card_count: number
  due_count: number
  mastery_score: number | null
}

type Course = {
  course_id: string
  name: string
  course_type: string | null
  icon: string | null
  icon_color: string | null
  professor_id: string | null
  professor_name: string | null
  topics: Topic[]
}

type TestResult = {
  result_id: string
  test_type: 'practice_quiz' | 'simulated_exam'
  score_pct: number | null
  question_count: number
  correct_count: number
  topic_filter: string | null
  created_at: string
}

type Material = {
  material_id: string
  tier: number | null
  file_type: string | null
  filename: string | null
  processing_status: string
  uploaded_at: string
}

type CourseExam = {
  exam_id: string
  date: string
  grade_weight: number | null
  duration_minutes: number | null
  student_score: number | null
}

const TIER_LABELS: Record<number, string> = {
  1: 'Syllabus',
  2: 'Lecture Notes',
  3: 'Textbook',
  4: 'Practice Problems',
}

function FileIcon({ fileType }: { fileType: string | null }) {
  if (fileType === 'pdf') return <FilePdf size={14} className="text-red-400" weight="fill" />
  if (fileType === 'image') return <ImageIcon size={14} className="text-blue-400" weight="fill" />
  if (fileType === 'typed') return <Keyboard size={14} className="text-primary" weight="fill" />
  return <FileText size={14} className="text-muted-foreground" weight="fill" />
}

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    processed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    processing: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    pending: 'bg-muted text-muted-foreground',
    failed: 'bg-red-500/10 text-red-500',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${styles[status] ?? styles.pending}`}>
      {status}
    </span>
  )
}

function DualBar({ mastery, coverage }: { mastery: number | null; coverage: number }) {
  const m = Math.round((mastery ?? 0) * 100)
  const c = Math.round(coverage * 100)
  const mColor = m >= 75 ? 'bg-emerald-500' : m >= 40 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-16 text-[10px] text-muted-foreground">Mastery</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${mColor}`} style={{ width: `${m}%` }} />
        </div>
        <span className="w-7 text-right text-[10px] tabular-nums text-muted-foreground">{m}%</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 text-[10px] text-muted-foreground">Coverage</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-blue-400" style={{ width: `${c}%` }} />
        </div>
        <span className="w-7 text-right text-[10px] tabular-nums text-muted-foreground">{c}%</span>
      </div>
    </div>
  )
}

function TopicRow({ topic, courseId, onRefresh }: { topic: Topic; courseId: string; onRefresh: () => void }) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/flashcards/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId, topicId: topic.topic_id }),
      })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Failed')
      else onRefresh()
    } catch {
      setError('Failed')
    } finally {
      setGenerating(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/topics/${topic.topic_id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError('Failed to delete')
        return
      }
      onRefresh()
    } catch {
      setError('Failed to delete')
    } finally {
      // Always reset so the button never sticks on 'Deleting…'
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium text-foreground">{topic.name}</span>
        {topic.card_count > 0 ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Cards size={11} />
              {topic.card_count}
            </span>
            {topic.due_count > 0 ? (
              <a
                href={`/review?topic=${topic.topic_id}`}
                className="flex items-center gap-1 rounded-lg bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                <Lightning size={10} weight="fill" />
                {topic.due_count} due — Review
              </a>
            ) : (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                All caught up
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1 rounded-lg bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
          >
            {generating ? <CircleNotch size={10} className="animate-spin" /> : <Lightning size={10} weight="fill" />}
            {generating ? 'Generating…' : 'Generate cards'}
          </button>
        )}
        <button
          onClick={() => setConfirming(v => !v)}
          aria-label="Delete topic"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
        >
          <Trash size={12} />
        </button>
      </div>
      <DualBar mastery={topic.mastery_score} coverage={topic.content_coverage} />
      {error && <span className="text-[11px] text-red-500">{error}</span>}
      {confirming && (
        <div className="flex items-center justify-between rounded-lg bg-destructive/5 border border-destructive/20 px-3 py-2">
          <span className="text-xs text-destructive">Delete topic and its flashcards?</span>
          <div className="flex items-center gap-2 ml-3 shrink-0">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 transition-colors"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TestResultRow({ result }: { result: TestResult }) {
  const scorePct = Math.round(result.score_pct ?? 0)
  const scoreColor = scorePct >= 75 ? 'text-emerald-500' : scorePct >= 50 ? 'text-amber-500' : 'text-red-500'
  const date = new Date(result.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${result.test_type === 'simulated_exam' ? 'bg-purple-500/10' : 'bg-primary/10'}`}>
        {result.test_type === 'simulated_exam'
          ? <GraduationCap size={15} className="text-purple-500" weight="fill" />
          : <ClipboardText size={15} className="text-primary" weight="fill" />
        }
      </div>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-sm text-foreground">
          {result.test_type === 'simulated_exam' ? 'Simulated Exam' : 'Practice Quiz'}
          {result.topic_filter && <span className="ml-1 text-muted-foreground">· {result.topic_filter}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{result.correct_count}/{result.question_count} correct · {date}</span>
      </div>
      <span className={`font-heading text-base font-bold tabular-nums ${scoreColor}`}>{scorePct}%</span>
    </div>
  )
}

function MaterialRow({ material, onDeleted }: { material: Material; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const date = new Date(material.uploaded_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const tierLabel = material.tier ? (TIER_LABELS[material.tier] ?? `Tier ${material.tier}`) : 'Uncategorized'

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/materials/${material.material_id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError('Failed to delete')
        return
      }
      onDeleted()
    } catch {
      setError('Failed to delete')
    } finally {
      // Always reset so the button never sticks on 'Deleting…'
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <FileIcon fileType={material.file_type} />
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm text-foreground truncate">{material.filename ?? 'Untitled'}</span>
          <span className="text-xs text-muted-foreground">{tierLabel} · {date}</span>
        </div>
        <StatusChip status={material.processing_status} />
        {error && <span className="text-[11px] text-red-500">{error}</span>}
        <button
          onClick={() => setConfirming(v => !v)}
          aria-label="Delete material"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
        >
          <Trash size={13} />
        </button>
      </div>
      {confirming && (
        <div className="flex items-center justify-between rounded-lg bg-destructive/5 border border-destructive/20 px-3 py-2">
          <span className="text-xs text-destructive">Remove this file? Topics and cards already generated are kept.</span>
          <div className="flex items-center gap-2 ml-3 shrink-0">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 transition-colors"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProfessorProfile({ wiki }: { wiki: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = wiki.slice(0, 300)
  const hasMore = wiki.length > 300

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <User size={14} className="text-primary" weight="fill" />
        <span className="text-sm font-semibold text-foreground">Professor Profile</span>
      </div>
      <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
        {expanded ? wiki : preview}
        {!expanded && hasMore && '…'}
      </div>
      {hasMore && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-2 flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
        >
          {expanded ? <CaretUp size={11} /> : <CaretDown size={11} />}
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function CourseUpload({ courseId, onDone }: { courseId: string; onDone: () => void }) {
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<{ name: string; ok: boolean }[]>([])

  const onDrop = useCallback(async (accepted: File[]) => {
    if (!accepted.length) return
    setUploading(true)
    const next: { name: string; ok: boolean }[] = []
    for (const file of accepted) {
      const form = new FormData()
      form.append('file', file)
      form.append('courseId', courseId)
      try {
        const res = await fetch('/api/inbox/upload', { method: 'POST', body: form })
        next.push({ name: file.name, ok: res.ok })
      } catch {
        next.push({ name: file.name, ok: false })
      }
    }
    setResults(next)
    setUploading(false)
    if (next.some(r => r.ok)) onDone()
    setTimeout(() => setResults([]), 3000)
  }, [courseId, onDone])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'], 'text/plain': ['.txt'], 'text/markdown': ['.md'] },
    multiple: true,
    disabled: uploading,
  })

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Upload to this course</h2>
      <div
        {...getRootProps()}
        className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-5 transition-colors ${
          uploading ? 'cursor-not-allowed border-border bg-muted/30'
            : isDragActive ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/10 hover:border-primary/50 hover:bg-muted/20'
        }`}
      >
        <input {...getInputProps()} />
        {uploading
          ? <><CircleNotch size={16} className="animate-spin text-primary" /><span className="text-sm text-muted-foreground">Uploading…</span></>
          : <><UploadSimple size={16} className="text-primary" weight="bold" /><span className="text-sm text-muted-foreground">{isDragActive ? 'Drop to upload' : 'Drop files or click — PDF, TXT, MD'}</span></>
        }
      </div>
      {results.length > 0 && (
        <div className="flex flex-col gap-1">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {r.ok
                ? <Check size={11} className="text-emerald-500" weight="bold" />
                : <X size={11} className="text-red-500" />
              }
              <span className={r.ok ? 'text-muted-foreground' : 'text-red-500'}>{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AudioPlayer({ url, estimatedMinutes }: { url: string; estimatedMinutes: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setProgress(audio.currentTime)
    const onMeta = () => setDuration(audio.duration)
    const onEnd = () => setPlaying(false)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
    }
  }, [])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) { audio.pause(); setPlaying(false) }
    else { audio.play(); setPlaying(true) }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current
    if (!audio) return
    const t = Number(e.target.value)
    audio.currentTime = t
    setProgress(t)
  }

  function changeSpeed(s: number) {
    setSpeed(s)
    if (audioRef.current) audioRef.current.playbackRate = s
  }

  function formatTime(s: number) {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const displayDuration = duration > 0 ? duration : estimatedMinutes * 60

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <audio ref={audioRef} src={url} preload="metadata" />
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {playing
            ? <Pause size={16} weight="fill" />
            : <Play size={16} weight="fill" />
          }
        </button>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <input
            type="range"
            min={0}
            max={displayDuration}
            value={progress}
            onChange={handleSeek}
            className="w-full h-1.5 cursor-pointer accent-primary"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] tabular-nums text-muted-foreground">{formatTime(progress)}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">{formatTime(displayDuration)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {[0.75, 1, 1.25, 1.5].map(s => (
            <button
              key={s}
              onClick={() => changeSpeed(s)}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                speed === s ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <a
          href={url}
          download="audio-overview.mp3"
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          <DownloadSimple size={12} weight="bold" />
          Download
        </a>
      </div>
    </div>
  )
}

type AudioOverview = { url: string; created_at: number }

function AudioOverviewSection({ courseId, hasOpenAI }: { courseId: string; hasOpenAI: boolean }) {
  const [history, setHistory] = useState<AudioOverview[]>([])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  useEffect(() => {
    fetch(`/api/agents/audio-overview?courseId=${courseId}`)
      .then(r => r.json())
      .then(json => { if (json.overviews) setHistory(json.overviews) })
      .catch(() => {})
  }, [courseId])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/agents/audio-overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Generation failed')
      const newOverview: AudioOverview = { url: json.url, created_at: Date.now() }
      setHistory(prev => [newOverview, ...prev])
      setExpandedIndex(0)
    } catch (e) {
      setError(String(e).replace('Error: ', ''))
    } finally {
      setGenerating(false)
    }
  }

  if (!hasOpenAI) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
        <Waveform size={14} className="text-muted-foreground shrink-0" weight="fill" />
        <span className="text-xs text-muted-foreground">Audio overviews require an OpenAI API key — add it in Settings.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        onClick={handleGenerate}
        disabled={generating}
        className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/20 disabled:opacity-50 transition-colors"
      >
        {generating
          ? <><CircleNotch size={15} className="animate-spin text-primary" />Generating overview… (~30–60 sec)</>
          : <><Waveform size={15} className="text-primary" weight="fill" />Generate audio overview</>
        }
      </button>
      {generating && (
        <p className="text-center text-xs text-amber-500">Don&apos;t navigate away — your overview will be lost if you leave this page.</p>
      )}
      {history.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Past overviews</p>
          {history.map((ov, i) => {
            const date = new Date(ov.created_at)
            const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
              ' · ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
            const open = expandedIndex === i
            return (
              <div key={ov.created_at} className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  onClick={() => setExpandedIndex(open ? null : i)}
                  className="flex w-full items-center justify-between px-4 py-3 text-xs text-foreground hover:bg-muted/20 transition-colors"
                >
                  <span className="font-medium">{label}</span>
                  {open ? <CaretUp size={12} /> : <CaretDown size={12} />}
                </button>
                {open && (
                  <div className="px-4 pb-4">
                    <AudioPlayer url={ov.url} estimatedMinutes={8} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ArchiveModal({
  courseName,
  onConfirm,
  onCancel,
}: {
  courseName: string
  onConfirm: (keepFlashcards: boolean, keepProfessor: boolean) => Promise<boolean>
  onCancel: () => void
}) {
  const [keepFlashcards, setKeepFlashcards] = useState(true)
  const [keepProfessor, setKeepProfessor] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setLoading(true)
    setError(null)
    const ok = await onConfirm(keepFlashcards, keepProfessor)
    // On success the parent navigates away; on failure recover the modal
    if (!ok) {
      setError('Archive failed — try again')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-background/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Archive course?</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{courseName}</p>
          </div>
          <button
            onClick={onCancel}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Keep flashcard deck?</p>
            <p className="text-xs text-muted-foreground leading-snug">
              Yes = review intervals doubled (slower decay). No = cards paused until reactivated.
            </p>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => setKeepFlashcards(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${keepFlashcards ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/30'}`}
              >
                Yes, keep
              </button>
              <button
                onClick={() => setKeepFlashcards(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${!keepFlashcards ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/30'}`}
              >
                No, pause
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Keep professor profile?</p>
            <p className="text-xs text-muted-foreground leading-snug">
              The professor&apos;s style notes will be deleted if you choose No.
            </p>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => setKeepProfessor(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${keepProfessor ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/30'}`}
              >
                Yes, keep
              </button>
              <button
                onClick={() => setKeepProfessor(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${!keepProfessor ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/30'}`}
              >
                No, delete
              </button>
            </div>
          </div>

          {error && <span className="text-xs text-red-500">{error}</span>}
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="mt-1 w-full rounded-xl bg-red-500 px-4 py-3 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Archiving…' : 'Archive course'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

function DeleteModal({
  courseName,
  onConfirm,
  onCancel,
}: {
  courseName: string
  onConfirm: () => Promise<boolean>
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmed = typed === courseName

  async function handleConfirm() {
    if (!confirmed) return
    setLoading(true)
    setError(null)
    const ok = await onConfirm()
    // On success the parent navigates away; on failure recover the modal
    if (!ok) {
      setError('Delete failed — try again')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-background/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Delete course?</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">This permanently deletes all topics, flashcards, and materials.</p>
          </div>
          <button
            onClick={onCancel}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-semibold text-foreground">{courseName}</span> to confirm.
            </p>
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={courseName}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-destructive/50"
            />
          </div>
          {error && <span className="text-xs text-red-500">{error}</span>}
          <button
            onClick={handleConfirm}
            disabled={!confirmed || loading}
            className="w-full rounded-xl bg-red-500 px-4 py-3 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Deleting…' : 'Delete course'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

const MATERIALS_PREVIEW_COUNT = 5

function MaterialsSection({
  materials,
  courseId,
  onDeleted,
}: {
  materials: Material[]
  courseId: string
  onDeleted: () => void
}) {
  const router = useRouter()
  const preview = materials.slice(0, MATERIALS_PREVIEW_COUNT)
  const hasMore = materials.length > MATERIALS_PREVIEW_COUNT

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Materials</h2>
        <span className="text-xs text-muted-foreground">{materials.length}</span>
      </div>
      <StaggerList className="flex flex-col gap-2">
        {preview.map(m => (
          <StaggerItem key={m.material_id}>
            <MaterialRow material={m} onDeleted={onDeleted} />
          </StaggerItem>
        ))}
      </StaggerList>
      {hasMore && (
        <button
          onClick={() => router.push(`/courses/${courseId}/materials`)}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
        >
          View all {materials.length} materials
          <ArrowRight size={12} />
        </button>
      )}
    </div>
  )
}

function ExamRow({ exam, courseId }: { exam: CourseExam; courseId: string }) {
  const [editing, setEditing] = useState(false)
  const [currentScore, setCurrentScore] = useState<number | null>(exam.student_score)
  const [value, setValue] = useState(exam.student_score != null ? String(exam.student_score) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const date = new Date(exam.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  async function handleSave() {
    const score = value.trim() === '' ? null : Number(value)
    if (score !== null && (isNaN(score) || score < 0 || score > 100)) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/courses/${courseId}/exams/${exam.exam_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_score: score }),
      })
      if (res.ok) {
        setCurrentScore(score)
        setEditing(false)
      } else {
        setError('Save failed')
      }
    } catch {
      setError('Save failed')
    } finally {
      // Always reset so the spinner never sticks
      setSaving(false)
    }
  }

  function handleCancel() {
    setEditing(false)
    setError(null)
    setValue(currentScore != null ? String(currentScore) : '')
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/10">
        <Exam size={15} className="text-purple-500" weight="fill" />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{date}</span>
        <span className="text-xs text-muted-foreground">
          {exam.grade_weight != null ? `${exam.grade_weight}% of grade` : 'Grade weight unknown'}
          {exam.duration_minutes ? ` · ${exam.duration_minutes} min` : ''}
        </span>
      </div>
      {editing ? (
        <div className="flex items-center gap-2 shrink-0">
          {error && <span className="text-[11px] text-red-500">{error}</span>}
          <input
            type="number"
            min={0}
            max={100}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="0–100"
            className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
            autoFocus
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
          >
            {saving ? <CircleNotch size={11} className="animate-spin" /> : <Check size={11} weight="bold" />}
          </button>
          <button
            onClick={handleCancel}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          {currentScore != null ? (
            <span className={`font-heading text-base font-bold tabular-nums ${currentScore >= 70 ? 'text-emerald-600 dark:text-emerald-400' : currentScore >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
              {currentScore}%
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No score</span>
          )}
          <button
            onClick={() => setEditing(true)}
            aria-label="Enter exam score"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            <PencilSimple size={11} />
          </button>
        </div>
      )}
    </div>
  )
}

function ExamsSection({ exams, courseId }: { exams: CourseExam[]; courseId: string }) {
  if (exams.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Exams</h2>
      <div className="flex flex-col gap-2">
        {exams.map(exam => (
          <ExamRow key={exam.exam_id} exam={exam} courseId={courseId} />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Enter your actual exam scores to activate grade prediction on the Progress tab.
      </p>
    </div>
  )
}

type WebSuggestion = { id: string; title: string | null; url: string | null; content: string }

function WebSuggestionBanner({ courseId, onAdded }: { courseId: string; onAdded: () => void }) {
  const [suggestion, setSuggestion] = useState<WebSuggestion | null>(null)
  const [checked, setChecked] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch(`/api/courses/${courseId}/web-suggestion`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.suggestion) setSuggestion(data.suggestion)
      })
      .catch(() => null)
      .finally(() => setChecked(true))
  }, [courseId])

  async function handleAdd() {
    if (!suggestion || adding) return
    setAdding(true)
    try {
      const res = await fetch(`/api/courses/${courseId}/web-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: suggestion.id }),
      })
      if (!res.ok) {
        setAdding(false)
        return
      }
      setDone(true)
      setTimeout(() => { setSuggestion(null); onAdded() }, 1800)
    } catch {
      setAdding(false)
    }
  }

  async function handleDismiss() {
    if (!suggestion) return
    await fetch(`/api/courses/${courseId}/web-suggestion`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestionId: suggestion.id }),
    }).catch(() => null)
    setSuggestion(null)
  }

  if (!checked || !suggestion) return null

  return (
    <AnimatePresence mode="wait">
      {!done ? (
        <motion.div
          key="banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900">
              <Globe size={15} className="text-blue-600 dark:text-blue-400" weight="fill" />
            </div>
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <span className="text-sm font-semibold text-foreground">Found a public syllabus online</span>
              {suggestion.url && (
                <span className="truncate text-[11px] text-muted-foreground">{suggestion.url}</span>
              )}
              {suggestion.title && (
                <span className="text-xs text-muted-foreground">{suggestion.title}</span>
              )}
            </div>
            <button
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            >
              <X size={12} />
            </button>
          </div>

          <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 bg-background/60 rounded-lg px-3 py-2 border border-border">
            {suggestion.content.slice(0, 300)}…
          </div>

          {expanded && (
            <div className="text-xs text-muted-foreground leading-relaxed bg-background/60 rounded-lg px-3 py-2 border border-border max-h-40 overflow-y-auto whitespace-pre-wrap">
              {suggestion.content}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={adding}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {adding ? <CircleNotch size={12} className="animate-spin" /> : <Check size={12} />}
              Add to course
            </button>
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? 'Show less' : 'Show full text'}
            </button>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="success"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40"
        >
          <CheckCircle size={15} className="text-emerald-600 dark:text-emerald-400" weight="fill" />
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            Syllabus added — topics and materials are being extracted.
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

type Mode = 'overview' | 'quiz' | 'exam'

export function CourseDetailClient({
  course,
  testResults,
  materials,
  exams,
  professorWiki,
  hasOpenAI,
  gradesSlot,
}: {
  course: Course
  testResults: TestResult[]
  materials: Material[]
  exams: CourseExam[]
  professorWiki: string | null
  hasOpenAI: boolean
  gradesSlot?: React.ReactNode
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('overview')
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const HeaderIcon = resolveIcon(course.icon)
  const headerPalette = resolveColor(course.icon_color)

  // Both return whether the call succeeded so the modal can show an error
  // instead of navigating away on a failed delete/archive.
  async function handleDelete(): Promise<boolean> {
    try {
      const res = await fetch(`/api/courses/${course.course_id}`, { method: 'DELETE' })
      if (!res.ok) return false
      router.push('/courses')
      router.refresh()
      return true
    } catch {
      return false
    }
  }

  async function handleArchive(keepFlashcards: boolean, keepProfessor: boolean): Promise<boolean> {
    try {
      const res = await fetch(`/api/courses/${course.course_id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepFlashcards, keepProfessor }),
      })
      if (!res.ok) return false
      router.push('/courses')
      router.refresh()
      return true
    } catch {
      return false
    }
  }

  const topicNames = course.topics.map(t => t.name)

  if (mode === 'quiz') {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <QuizSession
          courseId={course.course_id}
          courseName={course.name}
          topicOptions={topicNames}
          onClose={() => { setMode('overview'); router.refresh() }}
        />
      </div>
    )
  }

  if (mode === 'exam') {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <QuizSession
          courseId={course.course_id}
          courseName={course.name}
          examMode
          onClose={() => { setMode('overview'); router.refresh() }}
        />
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4 shrink-0">
          <button
            onClick={() => router.back()}
            aria-label="Back"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${headerPalette.bg}`}>
            <HeaderIcon size={18} className={headerPalette.icon} weight="fill" />
          </div>
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">{course.name}</span>
            {course.professor_name && (
              <span className="text-xs text-muted-foreground">{course.professor_name}</span>
            )}
          </div>
          <button
            onClick={() => setShowArchiveModal(true)}
            aria-label="Archive course"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            <Archive size={16} />
          </button>
          <button
            onClick={() => setShowDeleteModal(true)}
            aria-label="Delete course"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <Trash size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col gap-6 p-5">

            {/* Practice buttons */}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMode('quiz')}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-4 text-left hover:bg-muted/20 transition-colors"
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
                  <ClipboardText size={18} className="text-primary" weight="fill" />
                </div>
                <span className="text-sm font-semibold text-foreground">Practice Quiz</span>
                <span className="text-xs text-muted-foreground leading-snug">Custom questions, weak-area weighted</span>
              </button>
              <button
                onClick={() => setMode('exam')}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-4 text-left hover:bg-muted/20 transition-colors"
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-purple-500/10">
                  <GraduationCap size={18} className="text-purple-500" weight="fill" />
                </div>
                <span className="text-sm font-semibold text-foreground">Simulated Exam</span>
                <span className="text-xs text-muted-foreground leading-snug">Timed, mirrors your professor&apos;s style</span>
              </button>
            </div>

            {/* Web syllabus suggestion banner */}
            <WebSuggestionBanner courseId={course.course_id} onAdded={() => router.refresh()} />

            {/* Upload to course */}
            <CourseUpload courseId={course.course_id} onDone={() => router.refresh()} />

            {/* Audio overview */}
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-foreground">Audio Overview</h2>
              <AudioOverviewSection courseId={course.course_id} hasOpenAI={hasOpenAI} />
            </div>

            {/* Professor profile */}
            {course.professor_name && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Professor Insights</h2>
                {professorWiki ? (
                  <ProfessorProfile wiki={professorWiki} />
                ) : (
                  <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
                    <User size={14} className="text-muted-foreground shrink-0" weight="fill" />
                    <span className="text-xs text-muted-foreground">
                      Profile for {course.professor_name} will build after course materials are uploaded and processed.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Topics */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Topics</h2>
                <span className="text-xs text-muted-foreground">{course.topics.length}</span>
              </div>
              {course.topics.length === 0 ? (
                <p className="text-sm text-muted-foreground">No topics yet — upload a syllabus in the Inbox.</p>
              ) : (
                <StaggerList className="flex flex-col gap-2">
                  {course.topics.map(topic => (
                    <StaggerItem key={topic.topic_id}>
                      <TopicRow
                        topic={topic}
                        courseId={course.course_id}
                        onRefresh={() => router.refresh()}
                      />
                    </StaggerItem>
                  ))}
                </StaggerList>
              )}
            </div>

            {/* Exams */}
            <ExamsSection exams={exams} courseId={course.course_id} />

            {/* Materials */}
            {materials.length > 0 && (
              <MaterialsSection
                materials={materials}
                courseId={course.course_id}
                onDeleted={() => router.refresh()}
              />
            )}

            {/* Grades (S1) */}
            {gradesSlot}

            {/* Test history */}
            {testResults.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Test History</h2>
                <StaggerList className="flex flex-col gap-2">
                  {testResults.map(r => (
                    <StaggerItem key={r.result_id}>
                      <TestResultRow result={r} />
                    </StaggerItem>
                  ))}
                </StaggerList>
              </div>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showArchiveModal && (
          <ArchiveModal
            courseName={course.name}
            onConfirm={handleArchive}
            onCancel={() => setShowArchiveModal(false)}
          />
        )}
        {showDeleteModal && (
          <DeleteModal
            courseName={course.name}
            onConfirm={handleDelete}
            onCancel={() => setShowDeleteModal(false)}
          />
        )}
      </AnimatePresence>
    </>
  )
}
