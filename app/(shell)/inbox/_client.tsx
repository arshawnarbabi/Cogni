'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useDropzone } from 'react-dropzone'
import { prettifyTitle } from '@/lib/filename'
import {
  FilePdf,
  FileText,
  File,
  UploadSimple,
  CircleNotch,
  Tray,
  X,
  PlusCircle,
  ArrowRight,
  Keyboard,
  Check,
  CalendarBlank,
  ArrowClockwise,
  ImageBroken,
  WarningCircle,
  Image as ImageIcon,
} from '@phosphor-icons/react'

type InboxItem = {
  inbox_item_id: string
  classification_status: 'pending' | 'classified' | 'unassigned' | 'failed' | 'unreadable'
  course_id: string | null
  tier: number | null
  created_at: string
  materials: {
    filename: string
    file_type: string | null
  }
  courses: {
    name: string
  } | null
}

type StagedItem = {
  id: string
  type: 'file' | 'text'
  file?: File
  context: string    // context hint for classification (for files) or label (for text)
  textContent: string  // the typed content (text entries only)
  name: string
  error?: string
  done?: boolean
  // Homework due date confirmation
  awaitingDueDate?: boolean
  detectedDueDate?: string | null  // YYYY-MM-DD or null
  confirmedDueDate?: string        // user-confirmed date
  inboxItemId?: string
  courseId?: string | null
}

const TIER_LABEL: Record<number, string> = {
  1: 'Syllabus',
  2: 'Primary',
  3: 'Supplementary',
  4: 'Misc',
}

function StatusBadge({ status }: { status: InboxItem['classification_status'] }) {
  const map = {
    pending:    { dot: 'bg-amber-400',  text: 'Processing…',    label: 'text-amber-600 dark:text-amber-400' },
    classified: { dot: 'bg-emerald-400', text: 'Classified',    label: 'text-emerald-600 dark:text-emerald-400' },
    unassigned: { dot: 'bg-orange-400', text: 'Review needed',  label: 'text-orange-600 dark:text-orange-400' },
    unreadable: { dot: 'bg-purple-400', text: 'Unreadable',     label: 'text-purple-600 dark:text-purple-400' },
    failed:     { dot: 'bg-red-400',    text: 'Failed',         label: 'text-red-600 dark:text-red-400' },
  }
  const { dot, text, label } = map[status]
  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${label}`}>
      <span className={`size-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  )
}

function FileIcon({ fileType }: { fileType: string | null }) {
  if (fileType === 'pdf') return <FilePdf size={18} className="text-red-400" weight="fill" />
  if (fileType === 'typed') return <Keyboard size={18} className="text-primary" weight="fill" />
  if (fileType === 'txt' || fileType === 'md') return <FileText size={18} className="text-muted-foreground" weight="fill" />
  if (fileType === 'png' || fileType === 'jpg' || fileType === 'jpeg' || fileType === 'webp') return <ImageIcon size={18} className="text-blue-400" weight="fill" />
  return <File size={18} className="text-muted-foreground" weight="fill" />
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function StagedItemRow({
  item,
  onRemove,
  onChange,
  onConfirmDueDate,
}: {
  item: StagedItem
  onRemove: () => void
  onChange: (patch: Partial<StagedItem>) => void
  onConfirmDueDate: (date: string) => void
}) {
  const [dateInput, setDateInput] = useState(item.detectedDueDate ?? '')
  const [confirmingDate, setConfirmingDate] = useState(false)
  const [showDateInput, setShowDateInput] = useState(!item.detectedDueDate)

  useEffect(() => {
    if (item.detectedDueDate) {
      setDateInput(item.detectedDueDate)
      setShowDateInput(false)
    }
  }, [item.detectedDueDate])

  return (
    <div className={`flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 ${
      item.done ? 'border-emerald-500/40 opacity-60'
      : item.awaitingDueDate ? 'border-amber-400/40'
      : item.error ? 'border-red-400/40'
      : 'border-border'
    }`}>
      <div className="flex items-center gap-2">
        {item.done
          ? <Check size={16} className="text-emerald-500 shrink-0" weight="bold" />
          : item.awaitingDueDate
            ? <CalendarBlank size={16} className="text-amber-500 shrink-0" weight="fill" />
            : item.type === 'text'
              ? <Keyboard size={16} className="text-primary shrink-0" weight="fill" />
              : <FileIcon fileType={item.file?.name.split('.').pop()?.toLowerCase() ?? 'txt'} />
        }
        <span className="flex-1 text-sm font-medium text-foreground truncate">{item.name}</span>
        {!item.done && !item.awaitingDueDate && (
          <button
            onClick={onRemove}
            aria-label="Remove"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {item.awaitingDueDate && (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-500/5 border border-amber-400/20 px-3 py-2.5">
          <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
            {item.detectedDueDate
              ? `Homework detected — we found a due date: ${new Date(item.detectedDueDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. Confirm or adjust below.`
              : 'Homework detected — no due date found in the file. Set one manually.'}
          </p>
          <div className="flex items-center gap-2">
            {showDateInput && (
              <input
                type="date"
                value={dateInput}
                onChange={e => setDateInput(e.target.value)}
                className="flex-1 rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            )}
            <button
              onClick={async () => {
                if (!dateInput) return
                setConfirmingDate(true)
                await onConfirmDueDate(dateInput)
                setConfirmingDate(false)
              }}
              disabled={!dateInput || confirmingDate}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {confirmingDate ? <CircleNotch size={11} className="animate-spin" /> : <Check size={11} weight="bold" />}
              Confirm
            </button>
            {!showDateInput && (
              <button
                onClick={() => setShowDateInput(true)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Change
              </button>
            )}
          </div>
        </div>
      )}

      {!item.done && !item.awaitingDueDate && item.type === 'text' && (
        <textarea
          value={item.textContent}
          onChange={e => onChange({ textContent: e.target.value })}
          placeholder="Type your notes here…"
          rows={4}
          className="w-full resize-none rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      )}

      {!item.done && !item.awaitingDueDate && (
        <input
          type="text"
          value={item.context}
          onChange={e => onChange({ context: e.target.value })}
          placeholder={item.type === 'text' ? 'Label (e.g. "Week 3 notes on limits")' : 'Context hint (optional) — e.g. "Week 3 lecture, Physics 101"'}
          className="w-full rounded-lg bg-muted/40 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      )}

      {item.error && (
        <span className="text-xs text-red-500">{item.error}</span>
      )}
    </div>
  )
}

type Course = { course_id: string; name: string }

export function InboxClient({ items: initialItems, courses }: { items: InboxItem[]; courses: Course[] }) {
  const router = useRouter()
  const [items, setItems] = useState<InboxItem[]>(initialItems)
  const [staged, setStaged] = useState<StagedItem[]>([])

  useEffect(() => { setItems(initialItems) }, [initialItems])
  const [processing, setProcessing] = useState(false)
  const counterRef = useRef(0)

  function nextId() {
    counterRef.current += 1
    return `item-${counterRef.current}`
  }

  const onDrop = useCallback((accepted: File[]) => {
    setStaged(prev => [
      ...prev,
      ...accepted.map(file => ({
        id: nextId(),
        type: 'file' as const,
        file,
        name: file.name,
        context: '',
        textContent: '',
      })),
    ])
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
    multiple: true,
    disabled: processing,
  })

  function addTextEntry() {
    setStaged(prev => [...prev, {
      id: nextId(),
      type: 'text',
      name: 'Text note',
      context: '',
      textContent: '',
    }])
  }

  function updateItem(id: string, patch: Partial<StagedItem>) {
    setStaged(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  function removeItem(id: string) {
    setStaged(prev => prev.filter(item => item.id !== id))
  }

  async function dismissItem(itemId: string) {
    setItems(prev => prev.filter(i => i.inbox_item_id !== itemId))
    await fetch(`/api/inbox/items/${itemId}`, { method: 'DELETE' })
  }

  async function confirmDueDate(stagedId: string, date: string) {
    const item = staged.find(s => s.id === stagedId)
    if (!item?.courseId || !item.inboxItemId) {
      updateItem(stagedId, { done: true, awaitingDueDate: false })
      return
    }
    let res: Response
    try {
      res = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course_id: item.courseId, name: prettifyTitle(item.name), due_date: date }),
      })
    } catch {
      updateItem(stagedId, { error: 'Could not save the assignment. Check your connection and try again.' })
      return
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as { error?: string }))
      updateItem(stagedId, { error: j.error ?? 'Could not save the assignment. Try again.' })
      return
    }
    updateItem(stagedId, { done: true, awaitingDueDate: false, error: undefined })
    setTimeout(() => setStaged(prev => prev.filter(s => s.id !== stagedId)), 1500)
  }

  async function retryItem(itemId: string) {
    setItems(prev => prev.map(i =>
      i.inbox_item_id === itemId ? { ...i, classification_status: 'pending' } : i
    ))
    const res = await fetch(`/api/inbox/items/${itemId}/retry`, { method: 'POST' })
    if (res.ok) {
      router.refresh()
    } else {
      setItems(prev => prev.map(i =>
        i.inbox_item_id === itemId ? { ...i, classification_status: 'failed' } : i
      ))
    }
  }

  async function assignItem(itemId: string, courseId: string) {
    setItems(prev => prev.map(i =>
      i.inbox_item_id === itemId
        ? { ...i, classification_status: 'classified', course_id: courseId, courses: courses.find(c => c.course_id === courseId) ? { name: courses.find(c => c.course_id === courseId)!.name } : i.courses }
        : i
    ))
    await fetch(`/api/inbox/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId }),
    })
  }

  async function processAll() {
    setProcessing(true)
    let anySuccess = false

    // Collect short text notes as shared context hints for file classification.
    // Short = likely a label/hint ("this is my calc homework"), not actual coursework.
    const sharedContext = staged
      .filter(item => !item.done && item.type === 'text' && item.textContent.trim().length < 400)
      .map(item => item.textContent.trim())
      .filter(Boolean)
      .join(' | ')

    for (const item of staged) {
      if (item.done) continue
      const form = new FormData()

      // For files: merge the item's own context hint with any shared text-note context
      if (item.type === 'file') {
        const combined = [item.context, sharedContext].filter(Boolean).join(' | ')
        if (combined) form.append('context', combined)
      } else if (item.context) {
        form.append('context', item.context)
      }

      if (item.type === 'file' && item.file) {
        form.append('file', item.file)
      } else if (item.type === 'text') {
        if (!item.textContent.trim()) {
          updateItem(item.id, { error: 'Text content is empty.' })
          continue
        }
        form.append('textContent', item.textContent)
        form.append('name', item.context || 'Note')
      }

      try {
        const res = await fetch('/api/inbox/upload', { method: 'POST', body: form })
        const json = await res.json()
        if (!res.ok) {
          updateItem(item.id, { error: json.error ?? 'Upload failed' })
        } else if (json.dismissed) {
          updateItem(item.id, { done: true, error: undefined })
          toast.info("Looks like a label, not course material — note dismissed.")
          anySuccess = true
        } else if (json.isHomework && json.courseId) {
          // Homework with a known course — prompt for due date confirmation before clearing
          updateItem(item.id, {
            error: undefined,
            awaitingDueDate: true,
            detectedDueDate: json.dueDate ?? null,
            inboxItemId: json.inbox_item_id,
            courseId: json.courseId,
          })
          anySuccess = true
        } else {
          updateItem(item.id, { done: true, error: undefined })
          anySuccess = true
        }
      } catch {
        updateItem(item.id, { error: 'Upload failed' })
      }
    }

    if (anySuccess) router.refresh()
    setProcessing(false)

    // Clear done items after a moment (items awaiting due date are cleared by confirmDueDate/skipDueDate)
    setTimeout(() => {
      setStaged(prev => prev.filter(item => !item.done || item.awaitingDueDate))
    }, 1500)
  }

  const pendingCount = staged.filter(item => !item.done).length

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-6 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload files or type notes — Cogni will classify and assign them automatically.
          </p>
        </div>

        {/* Drop zone */}
        <div
          {...getRootProps()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 transition-colors ${
            processing
              ? 'border-border bg-muted/30 cursor-not-allowed'
              : isDragActive
                ? 'border-primary bg-primary/5'
                : 'border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/30'
          }`}
        >
          <input {...getInputProps()} />
          <div className="flex size-11 items-center justify-center rounded-full bg-primary/10">
            <UploadSimple size={20} className="text-primary" weight="bold" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">
              {isDragActive ? 'Drop to add' : 'Drop files or click to browse'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">PDF, TXT, PNG, JPG — multiple files supported</p>
          </div>
        </div>

        {/* Staged items */}
        {staged.length > 0 && (
          <div className="flex flex-col gap-2">
            {staged.map(item => (
              <StagedItemRow
                key={item.id}
                item={item}
                onRemove={() => removeItem(item.id)}
                onChange={patch => updateItem(item.id, patch)}
                onConfirmDueDate={date => confirmDueDate(item.id, date)}
              />
            ))}
          </div>
        )}

        {/* Add text note + Process row */}
        <div className="flex items-center gap-3">
          <button
            onClick={addTextEntry}
            disabled={processing}
            className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/10 px-4 py-2.5 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors disabled:opacity-40"
          >
            <PlusCircle size={15} weight="fill" />
            Add text note
          </button>

          {pendingCount > 0 && (
            <button
              onClick={processAll}
              disabled={processing}
              className="ml-auto flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {processing
                ? <><CircleNotch size={14} className="animate-spin" /> Processing…</>
                : <><ArrowRight size={14} weight="bold" /> Process {pendingCount} {pendingCount === 1 ? 'item' : 'items'}</>
              }
            </button>
          )}
        </div>

        {/* Item list */}
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
            <Tray size={36} className="text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nothing here yet. Upload your first document above.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-foreground">Recent uploads</h2>
            {items.map((item) => (
              <div
                key={item.inbox_item_id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-4">
                  <FileIcon fileType={item.materials.file_type} />

                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <span className="truncate text-sm font-medium text-foreground">
                      {item.materials.filename}
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={item.classification_status} />
                      {item.courses && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {item.courses.name}
                        </span>
                      )}
                      {item.tier && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {TIER_LABEL[item.tier] ?? `Tier ${item.tier}`}
                        </span>
                      )}
                    </div>
                  </div>

                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.created_at)}</span>

                  {(item.classification_status === 'unassigned' || item.classification_status === 'failed' || item.classification_status === 'unreadable') && (
                    <button
                      onClick={() => dismissItem(item.inbox_item_id)}
                      aria-label="Dismiss"
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {item.classification_status === 'unassigned' && (
                  <div className="flex flex-col gap-2 pl-7">
                    <div className="flex items-center gap-1.5 text-xs text-orange-600 dark:text-orange-400">
                      <WarningCircle size={13} weight="fill" />
                      Couldn&apos;t determine which course this belongs to — assign it below.
                    </div>
                    {courses.length > 0 && (
                      <select
                        defaultValue=""
                        onChange={e => { if (e.target.value) assignItem(item.inbox_item_id, e.target.value) }}
                        className="flex-1 rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      >
                        <option value="" disabled>Assign to a course…</option>
                        {courses.map(c => (
                          <option key={c.course_id} value={c.course_id}>{c.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {item.classification_status === 'unreadable' && (
                  <div className="flex flex-col gap-2 pl-7">
                    <div className="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400">
                      <ImageBroken size={13} weight="fill" />
                      Couldn&apos;t read this file — it may be an image-only PDF. Assign it manually below.
                    </div>
                    {courses.length > 0 && (
                      <select
                        defaultValue=""
                        onChange={e => { if (e.target.value) assignItem(item.inbox_item_id, e.target.value) }}
                        className="flex-1 rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      >
                        <option value="" disabled>Assign to a course…</option>
                        {courses.map(c => (
                          <option key={c.course_id} value={c.course_id}>{c.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {item.classification_status === 'failed' && (
                  <div className="flex items-center gap-3 pl-7">
                    <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                      <WarningCircle size={13} weight="fill" />
                      Processing failed.
                    </div>
                    <button
                      onClick={() => retryItem(item.inbox_item_id)}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:opacity-70 transition-opacity"
                    >
                      <ArrowClockwise size={12} weight="bold" />
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
