'use client'

import { useEditor, EditorContent, Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Color from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import FontFamily from '@tiptap/extension-font-family'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import Link from '@tiptap/extension-link'
import { Mark, mergeAttributes, Extension } from '@tiptap/core'
import { useEffect, useCallback, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  TextB, TextItalic, TextUnderline, TextStrikethrough,
  ListBullets, ListNumbers,
  TextAlignLeft, TextAlignCenter, TextAlignRight, TextAlignJustify,
  Table as TableIcon,
  ArrowCounterClockwise, ArrowClockwise,
  Minus,
  Warning,
  Check,
  CaretDown,
  Copy, FilePdf, FileDoc, FileText, DownloadSimple,
  Quotes,
  Highlighter,
  TextAa,
  Link as LinkIcon,
  Eraser,
  TextSuperscript,
  TextSubscript,
  ArrowLineLeft, ArrowLineRight,
  LineSegment,
  Sliders,
  X,
  Trash,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  CornersOut,
  PaintBucket,
} from '@phosphor-icons/react'

// ── Custom TableCell with background color support ────────────────────────────

const CustomTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      background: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.background ? { style: `background-color: ${attrs.background}` } : {},
      },
    }
  },
})

// ── Custom TipTap marks for tracked changes ───────────────────────────────────

const SuggestedAdd = Mark.create({
  name: 'suggestedAdd',
  parseHTML() { return [{ tag: 'span[data-suggested-add]' }] },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-suggested-add': '' }), 0]
  },
})

const SuggestedDel = Mark.create({
  name: 'suggestedDel',
  parseHTML() { return [{ tag: 'span[data-suggested-del]' }] },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-suggested-del': '' }), 0]
  },
})

// Font size as a TextStyle attribute
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.fontSize || null,
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
        },
      },
    }]
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addCommands(): any {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFontSize: (size: string) => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: size }).run(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsetFontSize: () => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    }
  },
})

// Line spacing as a paragraph attribute
const LineSpacing = Extension.create({
  name: 'lineSpacing',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.lineHeight || null,
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {},
        },
      },
    }]
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addCommands(): any {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setLineSpacing: (lineHeight: string) => ({ commands }: any) => {
        commands.updateAttributes('paragraph', { lineHeight })
        commands.updateAttributes('heading', { lineHeight })
        return true
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsetLineSpacing: () => ({ commands }: any) => {
        commands.updateAttributes('paragraph', { lineHeight: null })
        commands.updateAttributes('heading', { lineHeight: null })
        return true
      },
    }
  },
})

// Tab key: 4 spaces in non-list context
const TabIndent = Extension.create({
  name: 'tabIndent',
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive('listItem')) return false
        editor.chain().focus().insertContent('    ').run()
        return true
      },
    }
  },
})

// ── Types ─────────────────────────────────────────────────────────────────────

export type AssistanceLevel = 'feedback' | 'suggest' | 'assist'

export interface SuggestedEdit {
  target: string
  replacement: string
}

type PageMargins = { top: number; right: number; bottom: number; left: number }

// ── Portal helper (escapes overflow:hidden parents) ───────────────────────────

function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted || typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

// Smart dropdown position: opens below button, clamps to viewport, auto-flips to left-align if near right edge
function dropdownStyle(btnRect: DOMRect, menuWidth: number, align: 'left' | 'right' = 'left'): React.CSSProperties {
  const gap = 4
  const pad = 8 // min distance from viewport edge
  const top = btnRect.bottom + gap
  let left: number | undefined
  let right: number | undefined

  if (align === 'right') {
    // align right edge of menu to right edge of button
    const r = window.innerWidth - btnRect.right
    right = Math.max(pad, r)
  } else {
    // align left edge of menu to left edge of button, but clamp if it would overflow right
    const natural = btnRect.left
    if (natural + menuWidth > window.innerWidth - pad) {
      // overflow: flip to right-align from button right edge
      const r = window.innerWidth - btnRect.right
      right = Math.max(pad, r)
    } else {
      left = Math.max(pad, natural)
    }
  }

  return { position: 'fixed', top, ...(left !== undefined ? { left } : { right }), zIndex: 9999, width: menuWidth }
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border shrink-0" />
}

function TBtn({
  active, onClick, title, children, disabled,
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      onMouseDown={e => { e.preventDefault(); onClick() }}
      title={title}
      disabled={disabled}
      className={`flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-40 ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

// ── Generic dropdown (portal-based, escapes overflow:hidden) ─────────────────

function Dropdown({
  trigger, children, align = 'left',
}: {
  trigger: React.ReactNode
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect())
    setOpen(o => !o)
  }

  const style: React.CSSProperties = rect ? dropdownStyle(rect, 144, align) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={toggle}
        className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors text-[12px]"
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open && rect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              onClick={() => setOpen(false)}
              style={style}
              className="rounded-xl border border-border bg-card p-1 shadow-lg"
            >
              {children}
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

function DItem({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onMouseDown={e => { e.preventDefault(); onClick() }}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
        active ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-muted/60'
      }`}
    >
      {active && <Check size={11} weight="bold" className="shrink-0" />}
      {!active && <span className="w-[11px] shrink-0" />}
      {label}
    </button>
  )
}

// ── Assistance level buttons ──────────────────────────────────────────────────

const LEVELS: { value: AssistanceLevel; label: string; tip: string }[] = [
  { value: 'feedback', label: 'Feedback Only', tip: 'Chat feedback only — AI will not edit your document' },
  { value: 'suggest',  label: 'Suggest',       tip: 'AI proposes tracked edits you can accept or reject' },
  { value: 'assist',   label: 'Full Assist',   tip: 'AI makes broader edits — still as tracked changes' },
]

function AssistanceButtons({ value, onChange }: { value: AssistanceLevel; onChange: (v: AssistanceLevel) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {LEVELS.map(l => (
        <button
          key={l.value}
          onClick={() => onChange(l.value)}
          title={l.tip}
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            value === l.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}

// ── Tracked change helpers ────────────────────────────────────────────────────

function applyAllChanges(editor: Editor, accept: boolean) {
  const { state, view, schema } = editor
  const { doc, tr } = state
  const addMark = schema.marks.suggestedAdd
  const delMark = schema.marks.suggestedDel

  const addRanges: { from: number; to: number }[] = []
  const delRanges: { from: number; to: number }[] = []

  doc.descendants((node, pos) => {
    if (!node.isText) return
    node.marks.forEach(mark => {
      if (mark.type === addMark) addRanges.push({ from: pos, to: pos + node.nodeSize })
      if (mark.type === delMark) delRanges.push({ from: pos, to: pos + node.nodeSize })
    })
  })

  let transaction = tr
  if (accept) {
    ;[...addRanges].reverse().forEach(({ from, to }) => {
      transaction = transaction.removeMark(from, to, addMark)
    })
    ;[...delRanges].reverse().forEach(({ from, to }) => {
      transaction = transaction.delete(from, to)
    })
  } else {
    ;[...addRanges].reverse().forEach(({ from, to }) => {
      transaction = transaction.delete(from, to)
    })
    ;[...delRanges].reverse().forEach(({ from, to }) => {
      transaction = transaction.removeMark(from, to, delMark)
    })
  }

  view.dispatch(transaction)
}

function hasPendingChanges(editor: Editor | null): boolean {
  if (!editor) return false
  const { doc, schema } = editor.state
  const addMark = schema.marks.suggestedAdd
  const delMark = schema.marks.suggestedDel
  let found = false
  doc.descendants(node => {
    if (found) return false
    if (node.marks.some(m => m.type === addMark || m.type === delMark)) found = true
  })
  return found
}

export function applyEdit(editor: Editor, edit: SuggestedEdit) {
  const { target, replacement } = edit

  if (!target) {
    const end = editor.state.doc.content.size - 1
    editor.chain().focus().insertContentAt(end, `\n${replacement}`).run()
    const newEnd = editor.state.doc.content.size - 1
    editor.chain()
      .setTextSelection({ from: end + 1, to: newEnd })
      .setMark('suggestedAdd')
      .run()
    return
  }

  // Build the searchable text together with a per-character map to ProseMirror
  // doc positions. The AI's targets come from getText(), whose '\n\n' block
  // separator adds 2 chars per paragraph break that don't exist as doc
  // positions — searching getText() but walking only text nodes (the old
  // approach) shifted every match past paragraph 1 onto the wrong text.
  let text = ''
  const posMap: number[] = []
  let separated = true // mirrors textBetween: only separate blocks that emitted text
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) posMap.push(pos + i)
      text += node.text
      separated = false
    } else if (!separated && node.isBlock) {
      // Same '\n\n' separator getText() uses; these chars have no doc position
      text += '\n\n'
      posMap.push(-1, -1)
      separated = true
    }
  })

  const idx = text.indexOf(target)
  if (idx === -1) return

  const startPos = posMap[idx]
  const lastCharPos = posMap[idx + target.length - 1]
  // Targets that begin or end on a block separator have no position to anchor to
  if (startPos === undefined || startPos === -1 || lastCharPos === undefined || lastCharPos === -1) return
  const endPos = lastCharPos + 1

  // Final guard: verify the mapped range really reads as the target before
  // touching the doc — better to drop the edit than strike the wrong text.
  if (editor.state.doc.textBetween(startPos, endPos, '\n\n') !== target) return

  // Insert replacement FIRST (before any marks), then mark both ranges.
  // If we set suggestedDel first, ProseMirror carries that stored mark into
  // the insertion and the replacement text also ends up red.
  const repLen = replacement.length
  editor.chain().focus()
    .insertContentAt(endPos, replacement)
    .setTextSelection({ from: endPos, to: endPos + repLen })
    .setMark('suggestedAdd')
    .setTextSelection({ from: startPos, to: endPos })
    .setMark('suggestedDel')
    .run()
}

// ── Link dialog (portal-based) ────────────────────────────────────────────────

function LinkDialog({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const isActive = editor.isActive('link')

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function applyLink() {
    if (!url.trim()) return
    const href = url.startsWith('http') ? url : `https://${url}`
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setOpen(false)
    setUrl('')
  }

  function removeLink() {
    editor.chain().focus().unsetLink().run()
    setOpen(false)
  }

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 256) : {}

  return (
    <div ref={wrapRef} className="relative">
      <TBtn
        active={isActive}
        title="Insert / edit link"
        onClick={() => {
          const existing = editor.getAttributes('link').href ?? ''
          setUrl(existing)
          if (wrapRef.current) setBtnRect(wrapRef.current.getBoundingClientRect())
          setOpen(o => !o)
        }}
      >
        <LinkIcon size={16} />
      </TBtn>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-3 shadow-lg"
            >
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Insert link</p>
              <input
                autoFocus
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applyLink() }}
                placeholder="https://example.com"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/40"
              />
              <div className="mt-2 flex gap-1.5">
                <button
                  onMouseDown={e => { e.preventDefault(); applyLink() }}
                  className="flex-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary/90"
                >
                  Apply
                </button>
                {isActive && (
                  <button
                    onMouseDown={e => { e.preventDefault(); removeLink() }}
                    className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60"
                  >
                    Remove
                  </button>
                )}
              </div>
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Color picker (portal-based) ───────────────────────────────────────────────

const TEXT_COLORS = [
  '#0F172A', '#475569', '#DC2626', '#EA580C', '#D97706',
  '#16A34A', '#0284C7', '#1D4ED8', '#7C3AED', '#DB2777',
]

const HIGHLIGHT_COLORS = [
  '#FEF08A', '#FDE68A', '#BBF7D0', '#BAE6FD', '#DDD6FE',
  '#FBCFE8', '#FCA5A5', '#6EE7B7', '#93C5FD', '#F0ABFC',
]

function ColorSwatchGrid({
  label, colors, current, onPick, onReset,
}: {
  label: string
  colors: string[]
  current: string | null
  onPick: (c: string) => void
  onReset: () => void
}) {
  return (
    <>
      <p className="mb-1.5 text-[10px] text-muted-foreground">{label}</p>
      <div className="flex gap-1 flex-wrap w-[122px]">
        {colors.map(c => (
          <button
            key={c}
            onMouseDown={e => { e.preventDefault(); onPick(c) }}
            style={{ backgroundColor: c }}
            className={`size-5 rounded transition-transform hover:scale-110 ${current === c ? 'ring-2 ring-offset-1 ring-primary' : ''}`}
          />
        ))}
        <button
          onMouseDown={e => { e.preventDefault(); onReset() }}
          className="size-5 rounded border border-dashed border-border text-[8px] text-muted-foreground flex items-center justify-center hover:bg-muted/60"
          title="Reset"
        >
          ✕
        </button>
      </div>
    </>
  )
}

function ColorPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = editor.getAttributes('textStyle').color ?? null

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
    setOpen(o => !o)
  }

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 152) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={toggle}
        title="Text color"
        className="flex flex-col items-center justify-center rounded-md p-1.5 transition-colors text-muted-foreground hover:bg-muted/70 hover:text-foreground"
      >
        <TextAa size={14} />
        <div className="mt-0.5 h-0.5 w-3.5 rounded-full" style={{ backgroundColor: current ?? '#0F172A' }} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-2.5 shadow-lg"
            >
              <ColorSwatchGrid
                label="Text color"
                colors={TEXT_COLORS}
                current={current}
                onPick={c => { editor.chain().focus().setColor(c).run(); setOpen(false) }}
                onReset={() => { editor.chain().focus().unsetColor().run(); setOpen(false) }}
              />
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

function HighlightPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const currentColor = editor.getAttributes('highlight').color ?? null

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
    setOpen(o => !o)
  }

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 152) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={toggle}
        title="Highlight color"
        className={`flex flex-col items-center justify-center rounded-md p-1.5 transition-colors ${editor.isActive('highlight') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
      >
        <Highlighter size={14} />
        <div className="mt-0.5 h-0.5 w-3.5 rounded-full" style={{ backgroundColor: currentColor ?? '#FEF08A' }} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-2.5 shadow-lg"
            >
              <ColorSwatchGrid
                label="Highlight color"
                colors={HIGHLIGHT_COLORS}
                current={currentColor}
                onPick={c => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(editor.chain().focus() as any).setHighlight({ color: c }).run()
                  setOpen(false)
                }}
                onReset={() => { editor.chain().focus().unsetHighlight().run(); setOpen(false) }}
              />
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Export dropdown (portal-based) ───────────────────────────────────────────

function ExportDropdown({
  onCopy, onMd, onTxt, onDocx, onPdf,
}: {
  onCopy: () => void
  onMd: () => void
  onTxt: () => void
  onDocx: () => void
  onPdf: () => void
}) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function flash(key: string, fn: () => void) {
    fn()
    setDone(d => ({ ...d, [key]: true }))
    setTimeout(() => setDone(d => ({ ...d, [key]: false })), 2000)
    setOpen(false)
  }

  const items = [
    { key: 'copy', label: 'Copy to clipboard', Icon: Copy,           fn: onCopy },
    { key: 'txt',  label: 'Download .txt',      Icon: FileText,       fn: onTxt },
    { key: 'md',   label: 'Download .md',       Icon: DownloadSimple, fn: onMd },
    { key: 'docx', label: 'Download .docx',     Icon: FileDoc,        fn: onDocx },
    { key: 'pdf',  label: 'Download .pdf',      Icon: FilePdf,        fn: onPdf },
  ]

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 176, 'right') : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
          setOpen(o => !o)
        }}
        title="Export"
        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
      >
        <DownloadSimple size={16} />
        <CaretDown size={10} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              style={style}
              className="rounded-xl border border-border bg-card p-1 shadow-lg"
            >
              {items.map(({ key, label, Icon, fn }) => (
                <button
                  key={key}
                  onClick={() => flash(key, fn)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors"
                >
                  {done[key]
                    ? <Check size={14} className="text-green-500" weight="bold" />
                    : <Icon size={14} className="text-muted-foreground" />
                  }
                  {label}
                </button>
              ))}
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Page settings panel (portal-based) ───────────────────────────────────────

function PageSettingsPanel({
  margins, onMarginsChange,
}: {
  margins: PageMargins
  onMarginsChange: (m: PageMargins) => void
}) {
  const [open, setOpen] = useState(false)
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const presets = [
    { label: 'Normal (1")',   value: { top: 96, right: 96, bottom: 96, left: 96 } },
    { label: 'Narrow (0.5")', value: { top: 48, right: 48, bottom: 48, left: 48 } },
    { label: 'Wide (2")',     value: { top: 96, right: 192, bottom: 96, left: 192 } },
    { label: 'MLA / APA',    value: { top: 96, right: 96, bottom: 96, left: 96 } },
  ]

  function field(label: string, key: keyof PageMargins) {
    const inchVal = (margins[key] / 96).toFixed(2)
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground w-12">{label}</span>
        <input
          type="number"
          step="0.25"
          min="0"
          max="4"
          value={inchVal}
          onChange={e => {
            const px = Math.round(parseFloat(e.target.value) * 96)
            onMarginsChange({ ...margins, [key]: isNaN(px) ? 0 : px })
          }}
          className="w-16 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-right outline-none focus:ring-1 focus:ring-primary/40"
        />
        <span className="text-[10px] text-muted-foreground">in</span>
      </div>
    )
  }

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 208) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={e => {
          e.preventDefault()
          if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
          setOpen(o => !o)
        }}
        title="Page settings (margins)"
        className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
      >
        <Sliders size={15} />
        <CaretDown size={9} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-3 shadow-lg"
            >
              <p className="mb-2 text-[11px] font-semibold text-foreground">Page margins</p>
              <div className="mb-3 flex flex-col gap-1">
                {presets.map(p => (
                  <button
                    key={p.label}
                    onMouseDown={e => { e.preventDefault(); onMarginsChange(p.value) }}
                    className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[11px] text-foreground hover:bg-muted/60 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="border-t border-border pt-2">
                <p className="mb-1.5 text-[10px] text-muted-foreground">Custom</p>
                <div className="flex flex-col gap-1.5">
                  {field('Top', 'top')}
                  {field('Bottom', 'bottom')}
                  {field('Left', 'left')}
                  {field('Right', 'right')}
                </div>
              </div>
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Table picker (hover grid, portal-based) ───────────────────────────────────

function TablePicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState({ rows: 0, cols: 0 })
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const GRID = 8

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
    setHover({ rows: 0, cols: 0 })
    setOpen(o => !o)
  }

  function insert(rows: number, cols: number) {
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
    setOpen(false)
  }

  // grid is 8 cols × 1.25rem = 10rem + 1.5rem padding = ~172px
  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 176) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={toggle}
        title="Insert table"
        className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${editor.isActive('table') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
      >
        <TableIcon size={16} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-3 shadow-lg"
            >
              <p className="mb-2 text-[11px] font-semibold text-foreground">
                {hover.rows > 0 && hover.cols > 0
                  ? `${hover.rows} × ${hover.cols} table`
                  : 'Insert table'}
              </p>
              <div
                className="grid gap-0.5"
                style={{ gridTemplateColumns: `repeat(${GRID}, 1.25rem)` }}
                onMouseLeave={() => setHover({ rows: 0, cols: 0 })}
              >
                {Array.from({ length: GRID * GRID }, (_, i) => {
                  const row = Math.floor(i / GRID) + 1
                  const col = (i % GRID) + 1
                  const active = row <= hover.rows && col <= hover.cols
                  return (
                    <div
                      key={i}
                      onMouseEnter={() => setHover({ rows: row, cols: col })}
                      onMouseDown={e => { e.preventDefault(); insert(row, col) }}
                      className={`size-5 rounded-sm border cursor-pointer transition-colors ${active ? 'bg-primary/30 border-primary/50' : 'border-border hover:bg-muted/50'}`}
                    />
                  )
                })}
              </div>
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FONT_FAMILIES = [
  { label: 'Default',          value: '' },
  { label: 'Times New Roman',  value: 'Times New Roman, serif' },
  { label: 'Georgia',          value: 'Georgia, serif' },
  { label: 'Garamond',         value: 'Garamond, serif' },
  { label: 'Arial',            value: 'Arial, sans-serif' },
  { label: 'Calibri',          value: 'Calibri, sans-serif' },
  { label: 'Helvetica',        value: 'Helvetica Neue, Helvetica, sans-serif' },
  { label: 'Courier New',      value: 'Courier New, monospace' },
]

const FONT_SIZES = ['10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48']

const LINE_SPACINGS = [
  { label: 'Single (1.0)',  value: '1' },
  { label: '1.15',          value: '1.15' },
  { label: '1.5',           value: '1.5' },
  { label: 'Double (2.0)',  value: '2' },
]

const STYLES = [
  { label: 'Normal text', level: 0 },
  { label: 'Heading 1',   level: 1 },
  { label: 'Heading 2',   level: 2 },
  { label: 'Heading 3',   level: 3 },
]

// ── Cell background color picker (table only) ─────────────────────────────────

const CELL_BG_COLORS = [
  null,       // no color (reset)
  '#FEF9C3', '#DCFCE7', '#DBEAFE', '#EDE9FE', '#FCE7F3',
  '#FED7AA', '#CCFBF1', '#E0F2FE', '#F3E8FF', '#FFE4E6',
]

function CellColorPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    if (!open && btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect())
    setOpen(o => !o)
  }

  const style: React.CSSProperties = btnRect ? dropdownStyle(btnRect, 152) : {}

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onMouseDown={toggle}
        title="Cell background color"
        className="flex flex-col items-center justify-center rounded-md p-1.5 transition-colors text-muted-foreground hover:bg-muted/70 hover:text-foreground"
      >
        <PaintBucket size={14} />
      </button>
      <AnimatePresence>
        {open && btnRect && (
          <Portal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={{ duration: 0.13 }}
              style={style}
              className="rounded-xl border border-border bg-card p-2.5 shadow-lg"
            >
              <p className="mb-1.5 text-[10px] text-muted-foreground">Cell background</p>
              <div className="flex gap-1 flex-wrap">
                {CELL_BG_COLORS.map((c, i) => (
                  <button
                    key={i}
                    onMouseDown={e => {
                      e.preventDefault()
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ;(editor.chain().focus() as any).setCellAttribute('background', c ?? null).run()
                      setOpen(false)
                    }}
                    style={c ? { backgroundColor: c } : {}}
                    className={`size-5 rounded transition-transform hover:scale-110 ${
                      c
                        ? 'border border-border/40'
                        : 'border border-dashed border-border text-[8px] text-muted-foreground flex items-center justify-center'
                    }`}
                    title={c ?? 'No color'}
                  >
                    {!c && '✕'}
                  </button>
                ))}
              </div>
            </motion.div>
          </Portal>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Main EssayEditor component ────────────────────────────────────────────────

interface EssayEditorProps {
  initialContent?: string
  assistance: AssistanceLevel
  onAssistanceChange: (v: AssistanceLevel) => void
  onContentChange: (text: string, html: string) => void
  onCopyToClipboard: (text: string) => void
  onExportMd: (text: string) => void
  onExportTxt: (text: string) => void
  onExportDocx: (html: string) => void
  onExportPdf: (html: string) => void
  onClose?: () => void
  editorRef?: (editor: Editor | null) => void
}

export function EssayEditor({
  initialContent,
  assistance,
  onAssistanceChange,
  onContentChange,
  onCopyToClipboard,
  onExportMd,
  onExportTxt,
  onExportDocx,
  onExportPdf,
  onClose,
  editorRef,
}: EssayEditorProps) {
  const [showDisclaimer, setShowDisclaimer] = useState(true)
  const [margins, setMargins] = useState<PageMargins>({ top: 96, right: 96, bottom: 96, left: 96 })

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      LineSpacing,
      Superscript,
      Subscript,
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      CustomTableCell,
      TableHeader,
      SuggestedAdd,
      SuggestedDel,
      TabIndent,
    ],
    content: initialContent ?? '',
    onUpdate: ({ editor }) => {
      onContentChange(editor.getText(), editor.getHTML())
    },
    editorProps: {
      attributes: {
        class: 'outline-none prose prose-sm dark:prose-invert max-w-none text-foreground prose-headings:font-semibold prose-p:leading-relaxed focus:outline-none',
      },
    },
  })

  // Derive active font size from editor state each render — avoids onSelectionUpdate state thrash
  const rawFontSize = editor?.getAttributes('textStyle').fontSize as string | undefined
  const activeFontSize = rawFontSize ? rawFontSize.replace('pt', '').replace('px', '') : '12'

  // Force re-render on selection change so isActive('table') etc. stay current
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (!editor) return
    const handler = () => forceUpdate(n => n + 1)
    editor.on('selectionUpdate', handler)
    return () => { editor.off('selectionUpdate', handler) }
  }, [editor])

  useEffect(() => {
    editorRef?.(editor)
    return () => editorRef?.(null)
  }, [editor, editorRef])

  const pending = hasPendingChanges(editor)

  const handleCopy  = useCallback(() => { if (editor) onCopyToClipboard(editor.getText()) }, [editor, onCopyToClipboard])
  const handleMd    = useCallback(() => { if (editor) onExportMd(editor.getText()) }, [editor, onExportMd])
  const handleTxt   = useCallback(() => { if (editor) onExportTxt(editor.getText()) }, [editor, onExportTxt])
  const handleDocx  = useCallback(() => { if (editor) onExportDocx(editor.getHTML()) }, [editor, onExportDocx])
  const handlePdf   = useCallback(() => { if (editor) onExportPdf(editor.getHTML()) }, [editor, onExportPdf])

  if (!editor) return null

  // Derive current style label
  const currentStyle = STYLES.find(s =>
    s.level === 0 ? !editor.isActive('heading') : editor.isActive('heading', { level: s.level })
  ) ?? STYLES[0]

  // Derive current font family label
  const currentFont = editor.getAttributes('textStyle').fontFamily ?? ''
  const currentFontLabel = FONT_FAMILIES.find(f => f.value === currentFont)?.label ?? 'Default'

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#f9fafc] dark:bg-[#0F172A]">

      {/* ── Disclaimer banner ── */}
      <AnimatePresence>
        {showDisclaimer && (
          <motion.div
            initial={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 border-b border-amber-200/50 bg-[#FFFBEB] px-4 py-2 dark:border-amber-900/30 dark:bg-[#1C1400] overflow-hidden shrink-0"
          >
            <Warning size={13} weight="fill" className="shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex-1 text-[11px] text-amber-700 dark:text-amber-400">
              This tool develops your thinking — not your essay.
            </span>
            <button
              onClick={() => setShowDisclaimer(false)}
              className="flex size-5 items-center justify-center rounded text-amber-500/60 hover:text-amber-600 transition-colors"
            >
              <X size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Toolbar (Google Docs-style, bg-white, clearly separated) ── */}
      <div className="shrink-0 bg-white dark:bg-[#1E293B] border-b-2 border-[#E2E8F0] dark:border-[#334155] shadow-sm">

        {/* Row 1: Style · Font · Size · Color · Assist · Export */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[#E2E8F0] dark:border-[#334155]/60 overflow-x-auto scrollbar-none">

          {/* Styles dropdown */}
          <Dropdown
            trigger={
              <span className="flex items-center gap-1 text-[12px] text-foreground min-w-[108px] justify-between">
                {currentStyle.label}
                <CaretDown size={10} className="text-muted-foreground" />
              </span>
            }
          >
            {STYLES.map(s => (
              <DItem
                key={s.label}
                label={s.label}
                active={currentStyle.label === s.label}
                onClick={() => {
                  if (s.level === 0) editor.chain().focus().setParagraph().run()
                  else editor.chain().focus().toggleHeading({ level: s.level as 1|2|3 }).run()
                }}
              />
            ))}
          </Dropdown>

          <Divider />

          {/* Font family */}
          <Dropdown
            trigger={
              <span className="flex items-center gap-1 text-[12px] text-foreground min-w-[110px] justify-between">
                {currentFontLabel}
                <CaretDown size={10} className="text-muted-foreground" />
              </span>
            }
          >
            {FONT_FAMILIES.map(f => (
              <DItem
                key={f.label}
                label={f.label}
                active={currentFont === f.value}
                onClick={() => {
                  if (f.value) editor.chain().focus().setFontFamily(f.value).run()
                  else editor.chain().focus().unsetFontFamily().run()
                }}
              />
            ))}
          </Dropdown>

          <Divider />

          {/* Font size */}
          <Dropdown
            trigger={
              <span className="flex items-center gap-0.5 text-[12px] text-foreground w-[46px] justify-between">
                {activeFontSize}
                <CaretDown size={10} className="text-muted-foreground" />
              </span>
            }
          >
            {FONT_SIZES.map(s => (
              <DItem
                key={s}
                label={s}
                active={activeFontSize === s}
                onClick={() => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(editor.chain().focus() as any).setFontSize(`${s}pt`).run()
                }}
              />
            ))}
          </Dropdown>

          <Divider />

          {/* Text color */}
          <ColorPicker editor={editor} />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Assistance level */}
          <span className="text-[11px] text-muted-foreground mr-1 shrink-0">Assistance:</span>
          <AssistanceButtons value={assistance} onChange={onAssistanceChange} />

          <Divider />

          {/* Page settings */}
          <PageSettingsPanel margins={margins} onMarginsChange={setMargins} />

          <Divider />

          {/* Export */}
          <ExportDropdown
            onCopy={handleCopy}
            onMd={handleMd}
            onTxt={handleTxt}
            onDocx={handleDocx}
            onPdf={handlePdf}
          />

          {/* Close essay panel */}
          {onClose && (
            <>
              <Divider />
              <button
                onClick={onClose}
                title="Close essay panel"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>

        {/* Row 2: Undo/Redo · formatting · alignment · indent · spacing · lists · insert */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 overflow-x-auto scrollbar-none">

          {/* History */}
          <TBtn onClick={() => editor.chain().focus().undo().run()} title="Undo (⌘Z)" disabled={!editor.can().undo()}>
            <ArrowCounterClockwise size={16} />
          </TBtn>
          <TBtn onClick={() => editor.chain().focus().redo().run()} title="Redo (⌘⇧Z)" disabled={!editor.can().redo()}>
            <ArrowClockwise size={16} />
          </TBtn>
          <TBtn onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()} title="Clear formatting">
            <Eraser size={16} />
          </TBtn>

          <Divider />

          {/* Inline formatting */}
          <TBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (⌘B)">
            <TextB size={16} weight="bold" />
          </TBtn>
          <TBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (⌘I)">
            <TextItalic size={16} />
          </TBtn>
          <TBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (⌘U)">
            <TextUnderline size={16} />
          </TBtn>
          <TBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
            <TextStrikethrough size={16} />
          </TBtn>
          <TBtn active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()} title="Superscript">
            <TextSuperscript size={16} />
          </TBtn>
          <TBtn active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()} title="Subscript">
            <TextSubscript size={16} />
          </TBtn>
          <HighlightPicker editor={editor} />

          <Divider />

          {/* Alignment */}
          <TBtn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Align left">
            <TextAlignLeft size={16} />
          </TBtn>
          <TBtn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Center">
            <TextAlignCenter size={16} />
          </TBtn>
          <TBtn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Align right">
            <TextAlignRight size={16} />
          </TBtn>
          <TBtn active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()} title="Justify">
            <TextAlignJustify size={16} />
          </TBtn>

          <Divider />

          {/* Indent / outdent (manual tab/shift-tab via content) */}
          <TBtn
            title="Indent"
            onClick={() => editor.chain().focus().insertContent('    ').run()}
          >
            <ArrowLineRight size={16} />
          </TBtn>
          <TBtn
            title="Decrease indent"
            onClick={() => {
              const { from } = editor.state.selection
              const text = editor.state.doc.textBetween(from - 4, from)
              if (text === '    ') {
                editor.chain().focus().deleteRange({ from: from - 4, to: from }).run()
              }
            }}
          >
            <ArrowLineLeft size={16} />
          </TBtn>

          <Divider />

          {/* Line spacing */}
          <Dropdown
            trigger={
              <span className="flex items-center gap-0.5 text-[12px] text-muted-foreground">
                <LineSegment size={15} />
                <CaretDown size={9} />
              </span>
            }
          >
            {LINE_SPACINGS.map(ls => (
              <DItem
                key={ls.value}
                label={ls.label}
                onClick={() => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(editor.chain().focus() as any).setLineSpacing(ls.value).run()
                }}
              />
            ))}
          </Dropdown>

          <Divider />

          {/* Lists */}
          <TBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
            <ListBullets size={16} />
          </TBtn>
          <TBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
            <ListNumbers size={16} />
          </TBtn>
          <TBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
            <Quotes size={16} />
          </TBtn>
          <TBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">
            <Minus size={16} />
          </TBtn>

          <Divider />

          {/* Insert */}
          <LinkDialog editor={editor} />
          <TablePicker editor={editor} />

          {/* Table editing controls — shown only when cursor is inside a table */}
          {editor.isActive('table') && (
            <>
              <Divider />
              <span className="text-[10px] text-muted-foreground px-1 shrink-0">Row:</span>
              <TBtn onClick={() => editor.chain().focus().addRowBefore().run()} title="Add row above">
                <ArrowUp size={14} />
              </TBtn>
              <TBtn onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below">
                <ArrowDown size={14} />
              </TBtn>
              <TBtn onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row">
                <Trash size={14} className="text-red-500" />
              </TBtn>
              <Divider />
              <span className="text-[10px] text-muted-foreground px-1 shrink-0">Col:</span>
              <TBtn onClick={() => editor.chain().focus().addColumnBefore().run()} title="Add column left">
                <ArrowLeft size={14} />
              </TBtn>
              <TBtn onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column right">
                <ArrowRight size={14} />
              </TBtn>
              <TBtn onClick={() => editor.chain().focus().deleteColumn().run()} title="Delete column">
                <Trash size={14} className="text-red-500" />
              </TBtn>
              <Divider />
              <TBtn
                onClick={() => editor.chain().focus().mergeOrSplit().run()}
                title="Merge / split cells"
              >
                <CornersOut size={14} />
              </TBtn>
              <CellColorPicker editor={editor} />
              <TBtn onClick={() => editor.chain().focus().deleteTable().run()} title="Delete table">
                <Trash size={16} weight="fill" className="text-red-500" />
              </TBtn>
            </>
          )}
        </div>
      </div>

      {/* ── Pending changes bar ── */}
      <AnimatePresence>
        {pending && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="flex items-center justify-between bg-white dark:bg-[#1E293B] border-b border-[#E2E8F0] dark:border-[#334155] px-4 py-1.5 shrink-0 overflow-hidden"
          >
            <span className="text-[11px] text-muted-foreground">Suggested changes pending</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => applyAllChanges(editor, true)}
                className="flex items-center gap-1 rounded-md bg-green-100 px-2.5 py-1 text-[11px] font-medium text-green-700 hover:bg-green-200 transition-colors dark:bg-green-950/40 dark:text-green-400"
              >
                <Check size={11} weight="bold" /> Accept all
              </button>
              <button
                onClick={() => applyAllChanges(editor, false)}
                className="flex items-center gap-1 rounded-md bg-red-100 px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-200 transition-colors dark:bg-red-950/40 dark:text-red-400"
              >
                <X size={11} weight="bold" /> Reject all
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Document area: gray background + centered white page (Google Docs style) ── */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">
        <div
          className="mx-auto bg-white dark:bg-[#1E2C3D] shadow-[0_1px_3px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_4px_16px_rgba(0,0,0,0.3)]"
          style={{
            maxWidth: 816,
            width: '100%',
            paddingTop: margins.top,
            paddingRight: margins.right,
            paddingBottom: margins.bottom,
            paddingLeft: margins.left,
            minHeight: 1056,
            backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 1055px, #e2e8f0 1055px, #e2e8f0 1056px)',
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      <style>{`
        span[data-suggested-add] {
          background-color: #DCFCE7;
          color: #16A34A;
          border-radius: 2px;
        }
        .dark span[data-suggested-add] {
          background-color: #052E16;
          color: #4ade80;
        }
        span[data-suggested-del] {
          background-color: #FEE2E2;
          color: #DC2626;
          text-decoration: line-through;
          border-radius: 2px;
        }
        .dark span[data-suggested-del] {
          background-color: #1C0606;
          color: #f87171;
        }
        .ProseMirror {
          min-height: 400px;
          caret-color: currentColor;
          font-size: 12pt;
          line-height: 1.5;
          color: #0F172A;
        }
        .dark .ProseMirror {
          color: #F8FAFC;
        }
        .ProseMirror:focus {
          outline: none;
        }
        .ProseMirror a {
          color: #1D4ED8;
          text-decoration: underline;
          cursor: pointer;
        }
        .ProseMirror table {
          border-collapse: collapse;
          width: 100%;
          margin: 1em 0;
        }
        .ProseMirror td, .ProseMirror th {
          border: 1px solid #e2e8f0;
          padding: 6px 12px;
          min-width: 80px;
          vertical-align: top;
        }
        .dark .ProseMirror td, .dark .ProseMirror th {
          border-color: #334155;
        }
        .ProseMirror th {
          background: #f8fafc;
          font-weight: 600;
        }
        .dark .ProseMirror th {
          background: #1e293b;
        }
        .ProseMirror .selectedCell {
          background: #dbeafe;
        }
      `}</style>
    </div>
  )
}
