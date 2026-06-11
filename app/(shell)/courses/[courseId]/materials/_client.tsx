'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  FilePdf,
  FileText,
  Image as ImageIcon,
  MagnifyingGlass,
  Trash,
  Funnel,
} from '@phosphor-icons/react'

type Material = {
  material_id: string
  tier: number | null
  file_type: string | null
  filename: string | null
  processing_status: string
  uploaded_at: string
}

const TIER_LABELS: Record<number, string> = {
  1: 'Syllabus',
  2: 'Lecture Notes',
  3: 'Textbook',
  4: 'Practice Problems',
}

function FileIcon({ fileType }: { fileType: string | null }) {
  if (fileType === 'pdf') return <FilePdf size={16} className="text-red-400 shrink-0" weight="fill" />
  if (fileType === 'image') return <ImageIcon size={16} className="text-blue-400 shrink-0" weight="fill" />
  return <FileText size={16} className="text-muted-foreground shrink-0" weight="fill" />
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    processed: { label: 'Processed', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
    processing: { label: 'Processing…', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    pending: { label: 'Pending', cls: 'bg-muted text-muted-foreground' },
    failed: { label: 'Failed', cls: 'bg-destructive/10 text-destructive' },
  }
  const s = map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${s.cls}`}>{s.label}</span>
}

function MaterialRow({ material, onDeleted }: { material: Material; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const date = new Date(material.uploaded_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
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
      // Only remove the row from the list once the server confirmed the delete
      onDeleted()
    } catch {
      setError('Failed to delete')
    } finally {
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

export function MaterialsClient({
  courseName,
  professorName,
  materials: initialMaterials,
}: {
  courseName: string
  professorName: string | null
  materials: Material[]
}) {
  const router = useRouter()
  const [materials, setMaterials] = useState(initialMaterials)
  const [search, setSearch] = useState('')
  const [tierFilter, setTierFilter] = useState<number | null>(null)
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')

  function handleDeleted(materialId: string) {
    setMaterials(prev => prev.filter(m => m.material_id !== materialId))
  }

  const filtered = materials
    .filter(m => {
      if (search && !m.filename?.toLowerCase().includes(search.toLowerCase())) return false
      if (tierFilter !== null && m.tier !== tierFilter) return false
      return true
    })
    .sort((a, b) => {
      const diff = new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime()
      return sort === 'newest' ? -diff : diff
    })

  const tiers = [...new Set(materials.map(m => m.tier).filter(Boolean))] as number[]

  return (
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
        <div className="flex flex-1 flex-col min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{courseName} — Materials</span>
          {professorName && <span className="text-xs text-muted-foreground">{professorName}</span>}
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{materials.length} files</span>
      </div>

      {/* Search + filter bar */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-3 shrink-0">
        <div className="relative flex-1">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by filename…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-card pl-8 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Tier filter */}
        {tiers.length > 1 && (
          <div className="flex items-center gap-1">
            <Funnel size={13} className="text-muted-foreground shrink-0" />
            <select
              value={tierFilter ?? ''}
              onChange={e => setTierFilter(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">All types</option>
              {tiers.map(t => (
                <option key={t} value={t}>{TIER_LABELS[t] ?? `Tier ${t}`}</option>
              ))}
            </select>
          </div>
        )}

        {/* Sort */}
        <select
          value={sort}
          onChange={e => setSort(e.target.value as 'newest' | 'oldest')}
          className="rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {/* List */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-2 p-5">
          {filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {search || tierFilter !== null ? 'No materials match your filters.' : 'No materials yet.'}
            </p>
          ) : (
            filtered.map(m => (
              <MaterialRow
                key={m.material_id}
                material={m}
                onDeleted={() => handleDeleted(m.material_id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
