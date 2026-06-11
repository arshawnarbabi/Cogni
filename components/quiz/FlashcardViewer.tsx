'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import {
  ArrowLeft,
  ArrowRight,
  Cards,
  X,
  CheckCircle,
} from '@phosphor-icons/react'
import { ease } from '@/components/ui/motion'
import { toast } from 'sonner'

type Flashcard = { front: string; back: string; card_id?: string }

type RatingSummary = {
  total: number
  again: number
  hard: number
  good: number
  easy: number
}

type Props = {
  cards: Flashcard[]
  topic: string
  onClose: () => void
  onComplete?: (summary: RatingSummary) => void
}

const RATINGS = [
  { label: 'Again', value: 1 as const, color: 'bg-red-500 hover:bg-red-600 text-white' },
  { label: 'Hard',  value: 2 as const, color: 'bg-orange-400 hover:bg-orange-500 text-white' },
  { label: 'Good',  value: 3 as const, color: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
  { label: 'Easy',  value: 4 as const, color: 'bg-blue-500 hover:bg-blue-600 text-white' },
]

function MathText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {text}
    </ReactMarkdown>
  )
}

export function FlashcardViewer({ cards, topic, onClose, onComplete }: Props) {
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [ratedMap, setRatedMap] = useState<Record<number, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // Guards the whole rate→auto-advance window. The ref is checked synchronously
  // so a second tap before re-render can't double-advance or fire onComplete twice.
  const [advancing, setAdvancing] = useState(false)
  const advancingRef = useRef(false)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset when tutor regenerates the deck (new cards array from parent).
  const lastCardsRef = useRef(cards)
  useEffect(() => {
    if (cards !== lastCardsRef.current) {
      lastCardsRef.current = cards
      setIndex(0)
      setFlipped(false)
      setDirection(1)
      setRatedMap({})
      // Cancel any pending auto-advance from the previous deck
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
      advancingRef.current = false
      setAdvancing(false)
    }
  }, [cards])

  const card = cards[index]

  function goNext() {
    if (index < cards.length - 1) {
      setDirection(1)
      setFlipped(false)
      setTimeout(() => setIndex(i => i + 1), 0)
    }
  }

  function goPrev() {
    if (index > 0) {
      setDirection(-1)
      setFlipped(false)
      setTimeout(() => setIndex(i => i - 1), 0)
    }
  }

  async function handleRate(rating: 1 | 2 | 3 | 4) {
    if (submitting || advancingRef.current) return
    advancingRef.current = true
    setAdvancing(true)
    setRatedMap(prev => ({ ...prev, [index]: rating }))
    if (card.card_id) {
      setSubmitting(true)
      try {
        const res = await fetch('/api/cards/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // clientReviewId: one uuid per rating tap — a network-level retry/replay
          // of this POST applies exactly once server-side (B6).
          body: JSON.stringify({ cardId: card.card_id, rating, clientReviewId: crypto.randomUUID() }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          console.error('[flashcard-review] failed', res.status, body)
          toast.error(`Review didn't save (${res.status}). Your FSRS scheduling may be stale.`)
        }
      } catch (e) {
        console.error('[flashcard-review] network error', e)
        toast.error("Couldn't reach server to save your review.")
      }
      setSubmitting(false)
    }
    // Auto-advance after rating, or show done screen on last card
    advanceTimerRef.current = setTimeout(() => {
      advancingRef.current = false
      setAdvancing(false)
      if (index < cards.length - 1) {
        setDirection(1)
        setFlipped(false)
        setIndex(i => i + 1)
      } else {
        const finalMap = { ...ratedMap, [index]: rating }
        const counts = { again: 0, hard: 0, good: 0, easy: 0 }
        Object.values(finalMap).forEach(r => {
          if (r === 1) counts.again++
          else if (r === 2) counts.hard++
          else if (r === 3) counts.good++
          else if (r === 4) counts.easy++
        })
        setDone(true)
        onComplete?.({ total: cards.length, ...counts })
      }
    }, 300)
  }

  // Dot indicator — always show active dot for current index
  const maxDots = Math.min(cards.length, 7)
  const activeDot = cards.length <= maxDots
    ? index
    : Math.round((index / (cards.length - 1)) * (maxDots - 1))

  function dotTargetIndex(i: number) {
    return maxDots === cards.length ? i : Math.round((i / (maxDots - 1)) * (cards.length - 1))
  }

  if (done) {
    const goodOrEasy = Object.values(ratedMap).filter(r => r >= 3).length
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
            <Cards size={14} className="text-primary" weight="fill" />
          </div>
          <span className="flex-1 text-sm font-semibold text-foreground truncate">Flashcards — {topic}</span>
          <button onClick={onClose} aria-label="Close flashcards" className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
            <CheckCircle size={28} className="text-emerald-600 dark:text-emerald-400" weight="fill" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">All done!</p>
            <p className="mt-1 text-sm text-muted-foreground">{cards.length} cards reviewed · {goodOrEasy} marked Good or Easy</p>
          </div>
          <div className="flex gap-2 text-xs">
            {[
              { label: 'Again', count: Object.values(ratedMap).filter(r => r === 1).length, color: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400' },
              { label: 'Hard',  count: Object.values(ratedMap).filter(r => r === 2).length, color: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400' },
              { label: 'Good',  count: Object.values(ratedMap).filter(r => r === 3).length, color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' },
              { label: 'Easy',  count: Object.values(ratedMap).filter(r => r === 4).length, color: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400' },
            ].filter(b => b.count > 0).map(b => (
              <span key={b.label} className={`rounded-lg px-2.5 py-1 font-medium ${b.color}`}>{b.label} ×{b.count}</span>
            ))}
          </div>
          <button
            onClick={onClose}
            className="mt-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
          <Cards size={14} className="text-primary" weight="fill" />
        </div>
        <span className="flex-1 text-sm font-semibold text-foreground truncate">Flashcards — {topic}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{index + 1}/{cards.length}</span>
        <button
          onClick={onClose}
          aria-label="Close flashcards"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1 shrink-0 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${((index + 1) / cards.length) * 100}%` }}
        />
      </div>

      {/* Card area */}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-5 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.button
            key={`${index}-${flipped ? 'back' : 'front'}`}
            onClick={() => setFlipped(f => !f)}
            initial={{ opacity: 0, x: direction * 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -30 }}
            transition={{ duration: 0.2, ease }}
            className="group relative flex w-full cursor-pointer select-none flex-col items-center justify-center rounded-2xl border border-border bg-card p-8 shadow-sm hover:border-primary/30 hover:shadow-md transition-all"
            style={{ minHeight: 260 }}
          >
            <div className="absolute top-3 right-3">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${flipped ? 'bg-emerald-500/10 text-emerald-600' : 'bg-primary/10 text-primary'}`}>
                {flipped ? 'Back' : 'Front'}
              </span>
            </div>

            <div className={`text-center text-base font-medium leading-relaxed ${flipped ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}`}>
              <MathText text={flipped ? card.back : card.front} />
            </div>

            {!flipped && (
              <p className="absolute bottom-3 text-[10px] text-muted-foreground/60 group-hover:text-muted-foreground/80 transition-colors">
                tap to reveal answer
              </p>
            )}
          </motion.button>
        </AnimatePresence>

        {/* Difficulty rating — only shown after flip */}
        <AnimatePresence>
          {flipped && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.15 }}
              className="flex w-full gap-2"
            >
              {RATINGS.map(r => (
                <button
                  key={r.value}
                  onClick={() => handleRate(r.value)}
                  disabled={submitting || advancing}
                  className={`flex flex-1 items-center justify-center rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50 ${
                    ratedMap[index] === r.value
                      ? r.color + ' ring-2 ring-offset-1 ring-current'
                      : r.color
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Nav */}
        <div className="flex items-center gap-3">
          <button
            onClick={goPrev}
            disabled={index === 0}
            className="flex size-10 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={16} />
          </button>

          {/* Dot indicators */}
          <div className="flex items-center gap-1.5">
            {Array.from({ length: maxDots }, (_, i) => (
              <button
                key={i}
                onClick={() => { setFlipped(false); setIndex(dotTargetIndex(i)) }}
                className={`rounded-full transition-all duration-200 ${activeDot === i ? 'w-3 h-3 bg-primary' : 'w-2 h-2 bg-muted hover:bg-muted-foreground/40'}`}
              />
            ))}
          </div>

          <button
            onClick={goNext}
            disabled={index === cards.length - 1}
            className="flex size-10 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
