'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { X, ArrowRight } from '@phosphor-icons/react'

type Card = {
  card_id: string
  front: string
  back: string
  hint: string | null
}

const RATINGS = [
  { label: 'Again', value: 1 as const, color: 'bg-red-500 hover:bg-red-600', key: '1' },
  { label: 'Hard',  value: 2 as const, color: 'bg-orange-400 hover:bg-orange-500', key: '2' },
  { label: 'Good',  value: 3 as const, color: 'bg-emerald-500 hover:bg-emerald-600', key: '3' },
  { label: 'Easy',  value: 4 as const, color: 'bg-blue-500 hover:bg-blue-600', key: '4' },
]

function FlipCard({ card, onRate }: { card: Card; onRate: (r: 1|2|3|4) => void }) {
  const [flipped, setFlipped] = useState(false)
  const [rating, setRating] = useState<number | null>(null)

  // Keyboard shortcuts: Space/Enter reveals the answer; 1–4 rate once revealed.
  // (These keys were advertised on the buttons but never wired up.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return
      if (!flipped) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFlipped(true) }
        return
      }
      if (rating !== null) return
      if (e.key >= '1' && e.key <= '4') {
        e.preventDefault()
        handleRate(Number(e.key) as 1 | 2 | 3 | 4)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // handleRate + card are stable for a mounted card; re-bind only on flip/rating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped, rating])

  async function handleRate(r: 1|2|3|4) {
    setRating(r)
    try {
      const res = await fetch('/api/cards/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // clientReviewId: one uuid per rating tap — a network-level retry/replay
        // of this POST applies exactly once server-side (B6).
        body: JSON.stringify({ cardId: card.card_id, rating: r, clientReviewId: crypto.randomUUID() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        console.error('[review] save failed', res.status, body)
        toast.error(`Review didn't save (${res.status}). Your FSRS scheduling may be stale.`)
      }
    } catch (e) {
      console.error('[review] network error', e)
      toast.error("Couldn't reach server to save your review.")
    } finally {
      onRate(r)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-between gap-6 p-6">
      {/* Card */}
      <div
        className="relative w-full max-w-lg cursor-pointer"
        style={{ perspective: '1000px', minHeight: 260 }}
        onClick={() => !flipped && setFlipped(true)}
      >
        <motion.div
          className="relative w-full"
          style={{ transformStyle: 'preserve-3d', minHeight: 260 }}
          animate={{ rotateY: flipped ? 180 : 0 }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
        >
          {/* Front */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-8 text-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            <p className="text-lg font-medium text-foreground leading-relaxed">{card.front}</p>
            {!flipped && (
              <p className="mt-4 text-xs text-muted-foreground">Tap to reveal answer</p>
            )}
          </div>

          {/* Back */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border border-border bg-primary/5 p-8 text-center"
            style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
          >
            <p className="text-base text-foreground leading-relaxed">{card.back}</p>
            {card.hint && (
              <p className="mt-3 text-xs text-muted-foreground italic">Hint: {card.hint}</p>
            )}
          </div>
        </motion.div>
      </div>

      {/* Rating buttons — only after flip */}
      <AnimatePresence>
        {flipped && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="flex w-full max-w-lg gap-3"
          >
            {RATINGS.map(r => (
              <button
                key={r.key}
                onClick={() => !rating && handleRate(r.value)}
                disabled={rating !== null}
                className={`flex flex-1 items-center justify-center rounded-xl py-3 text-sm font-semibold text-white transition-all ${r.color} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {r.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function ReviewClient({ cards }: { cards: Card[] }) {
  const router = useRouter()
  const [index, setIndex] = useState(0)
  const [done, setDone] = useState(false)
  const [ratings, setRatings] = useState<number[]>([])

  const total = cards.length
  const current = cards[index]

  function handleRate(r: 1|2|3|4) {
    setRatings(prev => [...prev, r])
    setTimeout(() => {
      if (index + 1 >= total) {
        setDone(true)
      } else {
        setIndex(i => i + 1)
      }
    }, 300)
  }

  if (done) {
    const goodCount = ratings.filter(r => r >= 3).length
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
          <span className="text-3xl">✓</span>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-foreground">Session complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} cards reviewed · {goodCount} marked Good or Easy
          </p>
        </div>
        <button
          onClick={() => { router.push('/today'); router.refresh() }}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"
        >
          Back to Today
          <ArrowRight size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border px-4 py-3">
        <button
          onClick={() => { router.push('/today'); router.refresh() }}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
        >
          <X size={18} />
        </button>
        <div className="flex flex-1 flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(index / total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{index + 1} / {total}</span>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.2 }}
          className="flex flex-1 flex-col"
        >
          <FlipCard card={current} onRate={handleRate} />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
