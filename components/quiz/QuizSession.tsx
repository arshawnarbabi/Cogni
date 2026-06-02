'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  XCircle,
  CircleNotch,
  Timer,
  Trophy,
  ClipboardText,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react'
import { ease } from '@/components/ui/motion'
import type { QuizQuestion, GradeSummary } from '@/lib/agents/practice-quiz'

export type { QuizQuestion }

type QuizFormat = 'mc' | 'short_answer' | 'mixed'
type Difficulty = 'easy' | 'medium' | 'hard'
type CheckTiming = 'after_each' | 'at_end'

type ConfigState = {
  topicFilters: string[]   // empty = all topics
  format: QuizFormat
  questionCount: number
  difficulty: Difficulty
  checkTiming: CheckTiming
}

type QuizPhase = 'config' | 'loading' | 'quiz' | 'grading' | 'results'

type Props = {
  courseId: string
  courseName: string
  topicOptions?: string[]
  initialQuestions?: QuizQuestion[]
  examMode?: boolean
  onClose?: () => void
  onComplete?: (summary: GradeSummary) => void
}

// ── Inline math-aware text renderer ──────────────────────────────────────────

function MathText({ text, block = false }: { text: string; block?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={block ? undefined : {
        p: ({ children }) => <span>{children}</span>,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

// ── Normalize questions from tutor (add type field if missing) ────────────────

function normalizeQuestion(q: object): QuizQuestion {
  const raw = q as Partial<QuizQuestion> & { options?: string[] }
  return {
    ...raw,
    question: raw.question ?? '',
    answer: raw.answer ?? '',
    explanation: raw.explanation ?? '',
    type: raw.type ?? (Array.isArray(raw.options) && raw.options.length > 0 ? 'mc' : 'short_answer'),
  } as QuizQuestion
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <motion.div
        className="h-full rounded-full bg-primary"
        initial={{ width: 0 }}
        animate={{ width: `${total > 0 ? (current / total) * 100 : 0}%` }}
        transition={{ duration: 0.3, ease }}
      />
    </div>
  )
}

function CountdownTimer({ totalSeconds, onExpire }: { totalSeconds: number; onExpire: () => void }) {
  const [remaining, setRemaining] = useState(totalSeconds)
  const expiredRef = useRef(false)

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearInterval(id)
          if (!expiredRef.current) {
            expiredRef.current = true
            onExpire()
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [onExpire])

  const mins = Math.floor(remaining / 60)
  const secs = remaining % 60
  const urgent = remaining < 300

  return (
    <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-mono font-semibold tabular-nums ${urgent ? 'bg-red-500/10 text-red-500' : 'bg-muted text-muted-foreground'}`}>
      <Timer size={12} weight={urgent ? 'fill' : 'regular'} />
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </div>
  )
}

// ── Topic search + multi-select ───────────────────────────────────────────────

function TopicPicker({
  options,
  selected,
  onChange,
}: {
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = options.filter(t =>
    t.toLowerCase().includes(search.toLowerCase())
  )

  function toggle(t: string) {
    onChange(selected.includes(t) ? selected.filter(s => s !== t) : [...selected, t])
  }

  function remove(t: string) {
    onChange(selected.filter(s => s !== t))
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Search input */}
      <div className="relative">
        <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search topics…"
          className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(t => (
            <span
              key={t}
              className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
            >
              {t}
              <button onClick={() => remove(t)} className="hover:text-primary/70 transition-colors">
                <X size={11} weight="bold" />
              </button>
            </span>
          ))}
          <button
            onClick={() => onChange([])}
            className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Scrollable list */}
      <div className="max-h-44 overflow-y-auto rounded-xl border border-border divide-y divide-border">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No topics match &ldquo;{search}&rdquo;</p>
        ) : (
          filtered.map(t => {
            const checked = selected.includes(t)
            return (
              <button
                key={t}
                onClick={() => toggle(t)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/30 ${checked ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <span className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${checked ? 'border-primary bg-primary' : 'border-border'}`}>
                  {checked && <CheckCircle size={11} className="text-primary-foreground" weight="fill" />}
                </span>
                <span className="flex-1 truncate">{t}</span>
              </button>
            )
          })
        )}
      </div>

      {/* Status line */}
      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? 'All topics — weighted toward your weakest areas'
          : `${selected.length} topic${selected.length > 1 ? 's' : ''} selected`
        }
      </p>
    </div>
  )
}

// ── Config form ────────────────────────────────────────────────────────────────

function ConfigForm({
  courseName,
  topicOptions,
  onStart,
  onBack,
  loading,
  examMode,
}: {
  courseName: string
  topicOptions?: string[]
  onStart: (cfg: ConfigState) => void
  onBack?: () => void
  loading: boolean
  examMode?: boolean
}) {
  const [topicFilters, setTopicFilters] = useState<string[]>([])
  const [format, setFormat] = useState<QuizFormat>('mc')
  const [questionCount, setQuestionCount] = useState(10)
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [checkTiming, setCheckTiming] = useState<CheckTiming>('after_each')

  const formats: { value: QuizFormat; label: string; desc: string }[] = [
    { value: 'mc', label: 'Multiple Choice', desc: 'Tap to select the correct answer' },
    { value: 'short_answer', label: 'Short Answer', desc: 'Type your answer in your own words' },
    { value: 'mixed', label: 'Mixed', desc: 'Combination of both types' },
  ]

  const difficulties: { value: Difficulty; label: string; color: string }[] = [
    { value: 'easy', label: 'Easy', color: 'border-emerald-500 bg-emerald-500/5 text-emerald-600' },
    { value: 'medium', label: 'Medium', color: 'border-amber-500 bg-amber-500/5 text-amber-600' },
    { value: 'hard', label: 'Hard', color: 'border-red-500 bg-red-500/5 text-red-600' },
  ]

  const counts = [5, 10, 15, 20]

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-5">
        {/* Back button + title */}
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <div>
            <h2 className="font-heading text-base font-semibold text-foreground">
              {examMode ? 'Simulated Exam' : 'Practice Quiz'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {examMode
                ? `Timed exam for ${courseName} mirroring your professor's style.`
                : `Custom quiz for ${courseName}, weighted toward weak topics.`
              }
            </p>
          </div>
        </div>

        {!examMode && (
          <>
            {/* Topic picker */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Topics <span className="normal-case font-normal">(optional — select one or more)</span>
              </label>
              {topicOptions && topicOptions.length > 0 ? (
                <TopicPicker
                  options={topicOptions}
                  selected={topicFilters}
                  onChange={setTopicFilters}
                />
              ) : (
                <input
                  type="text"
                  value={topicFilters[0] ?? ''}
                  onChange={e => setTopicFilters(e.target.value ? [e.target.value] : [])}
                  placeholder="e.g. Derivatives, Integration… (leave blank for all)"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              )}
            </div>

            {/* Format */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Format</label>
              <div className="flex flex-col gap-1.5">
                {formats.map(f => (
                  <button
                    key={f.value}
                    onClick={() => setFormat(f.value)}
                    className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      format === f.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-border/80 hover:bg-muted/30'
                    }`}
                  >
                    <span className="text-sm font-medium text-foreground">{f.label}</span>
                    <span className="text-xs text-muted-foreground">{f.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Difficulty */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Difficulty</label>
              <div className="flex gap-2">
                {difficulties.map(d => (
                  <button
                    key={d.value}
                    onClick={() => setDifficulty(d.value)}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      difficulty === d.value ? d.color : 'border-border text-muted-foreground hover:bg-muted/30'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Question count */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Questions</label>
              <div className="flex gap-2">
                {counts.map(n => (
                  <button
                    key={n}
                    onClick={() => setQuestionCount(n)}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      questionCount === n
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted/30'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Check timing */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Answer Feedback</label>
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => setCheckTiming('after_each')}
                  className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    checkTiming === 'after_each' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30'
                  }`}
                >
                  <span className="text-sm font-medium text-foreground">Check after each question</span>
                  <span className="text-xs text-muted-foreground">See if you&apos;re right immediately, with explanation</span>
                </button>
                <button
                  onClick={() => setCheckTiming('at_end')}
                  className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    checkTiming === 'at_end' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30'
                  }`}
                >
                  <span className="text-sm font-medium text-foreground">Show results at the end</span>
                  <span className="text-xs text-muted-foreground">Answer all questions, then see your score</span>
                </button>
              </div>
            </div>
          </>
        )}

        {examMode && (
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <p>The exam is timed to match your course exam duration. Once started, it cannot be paused. Questions are generated to mirror your professor&apos;s style and topic weighting.</p>
          </div>
        )}

        <button
          onClick={() => onStart({ topicFilters, format, questionCount, difficulty, checkTiming })}
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? (
            <><CircleNotch size={16} className="animate-spin" /> Generating questions…</>
          ) : (
            <>{examMode ? 'Start Exam' : 'Start Quiz'} <ArrowRight size={16} weight="bold" /></>
          )}
        </button>
      </div>
    </div>
  )
}

// ── Question card ─────────────────────────────────────────────────────────────

type FeedbackState = { correct: boolean; userAnswer: string } | null

function QuestionCard({
  question,
  index,
  total,
  checkTiming,
  onAnswer,
}: {
  question: QuizQuestion
  index: number
  total: number
  checkTiming: CheckTiming
  onAnswer: (answer: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [shortAnswer, setShortAnswer] = useState('')
  const [feedback, setFeedback] = useState<FeedbackState>(null)

  function submit() {
    const answer = question.type === 'mc' ? (selected ?? '') : shortAnswer
    if (checkTiming === 'after_each' && question.type === 'mc') {
      const correct = answer.trim().toLowerCase() === question.answer.trim().toLowerCase()
      setFeedback({ correct, userAnswer: answer })
    } else {
      onAnswer(answer)
    }
  }

  function handleNext() {
    onAnswer(feedback?.userAnswer ?? (question.type === 'mc' ? (selected ?? '') : shortAnswer))
  }

  const canSubmit = question.type === 'mc' ? !!selected && !feedback : shortAnswer.trim().length > 0

  return (
    <motion.div
      key={index}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.22, ease }}
      className="flex flex-1 flex-col gap-4 overflow-y-auto p-5"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {question.topic_name && <><span>{question.topic_name}</span><span>·</span></>}
        <span>Question {index + 1} of {total}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${question.type === 'mc' ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-600'}`}>
          {question.type === 'mc' ? 'MC' : 'Short Answer'}
        </span>
      </div>

      <div className="text-base font-medium text-foreground leading-relaxed">
        <MathText text={question.question} block />
      </div>

      {question.type === 'mc' && question.options && (
        <div className="flex flex-col gap-2">
          {question.options.map((opt, i) => {
            let optClass = 'border-border text-foreground hover:border-primary/40 hover:bg-muted/30'
            if (feedback) {
              if (opt === question.answer) {
                optClass = 'border-emerald-500 bg-emerald-500/8 text-emerald-700'
              } else if (opt === feedback.userAnswer && !feedback.correct) {
                optClass = 'border-red-500 bg-red-500/8 text-red-700'
              } else {
                optClass = 'border-border text-muted-foreground opacity-50'
              }
            } else if (selected === opt) {
              optClass = 'border-primary bg-primary/8 text-primary font-medium'
            }
            return (
              <button
                key={i}
                onClick={() => !feedback && setSelected(opt)}
                disabled={!!feedback}
                className={`rounded-xl border px-4 py-3 text-left text-sm transition-colors ${optClass}`}
              >
                <MathText text={opt} />
              </button>
            )
          })}
        </div>
      )}

      {question.type === 'short_answer' && (
        <textarea
          value={shortAnswer}
          onChange={e => setShortAnswer(e.target.value)}
          placeholder="Type your answer…"
          rows={4}
          className="w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      )}

      {/* Immediate feedback display */}
      {feedback && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-xl border p-3.5 flex flex-col gap-1.5 ${feedback.correct ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}
        >
          <div className="flex items-center gap-2">
            {feedback.correct
              ? <CheckCircle size={15} className="text-emerald-500 shrink-0" weight="fill" />
              : <XCircle size={15} className="text-red-500 shrink-0" weight="fill" />
            }
            <span className={`text-sm font-medium ${feedback.correct ? 'text-emerald-600' : 'text-red-600'}`}>
              {feedback.correct ? 'Correct!' : `Incorrect — correct answer: `}
              {!feedback.correct && <span className="font-normal"><MathText text={question.answer} /></span>}
            </span>
          </div>
          {question.explanation && (
            <p className="text-xs text-muted-foreground pl-5">{question.explanation}</p>
          )}
        </motion.div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {feedback ? (
          <button
            onClick={handleNext}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {index < total - 1 ? 'Next Question' : 'See Results'}
            <ArrowRight size={15} weight="bold" />
          </button>
        ) : (
          <>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {question.type === 'mc' ? (index < total - 1 ? 'Submit' : 'Submit') : (index < total - 1 ? 'Submit' : 'Submit')}
              <ArrowRight size={15} weight="bold" />
            </button>
            {question.type === 'short_answer' && (
              <button
                onClick={() => onAnswer('')}
                className="w-full rounded-xl py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip this question
              </button>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}

// ── Results screen ─────────────────────────────────────────────────────────────

function ResultsScreen({
  questions,
  userAnswers,
  summary,
  onRetry,
  onClose,
}: {
  questions: QuizQuestion[]
  userAnswers: string[]
  summary: GradeSummary
  onRetry?: () => void
  onClose?: () => void
}) {
  const [showReview, setShowReview] = useState(false)
  const { correctCount, scorePct, missedTopics, masteryUpdates } = summary
  const scoreColor = scorePct >= 75 ? 'text-emerald-500' : scorePct >= 50 ? 'text-amber-500' : 'text-red-500'
  const scoreBg = scorePct >= 75 ? 'bg-emerald-500/10' : scorePct >= 50 ? 'bg-amber-500/10' : 'bg-red-500/10'

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-5">
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease }}
          className={`flex flex-col items-center gap-2 rounded-2xl ${scoreBg} py-8`}
        >
          <Trophy size={32} className={scoreColor} weight="fill" />
          <div className={`font-heading text-5xl font-bold tabular-nums ${scoreColor}`}>{Math.round(scorePct)}%</div>
          <p className="text-sm text-muted-foreground">{correctCount} of {questions.length} correct</p>
        </motion.div>

        {masteryUpdates.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mastery Updated</p>
            <div className="flex flex-col gap-1.5">
              {masteryUpdates.map((u, i) => {
                const delta = u.newScore - u.oldScore
                return (
                  <div key={i} className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2">
                    <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                      <span className="text-sm text-foreground truncate">{u.topicName}</span>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${u.newScore >= 0.75 ? 'bg-emerald-500' : u.newScore >= 0.4 ? 'bg-amber-400' : 'bg-red-400'}`}
                            style={{ width: `${Math.round(u.newScore * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground">{Math.round(u.newScore * 100)}%</span>
                      </div>
                    </div>
                    <span className={`text-xs font-medium tabular-nums ${delta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {delta >= 0 ? '+' : ''}{Math.round(delta * 100)}%
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {missedTopics.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Focus Areas</p>
            <div className="flex flex-wrap gap-1.5">
              {missedTopics.map((m, i) => (
                <span key={i} className="rounded-full bg-red-500/10 px-3 py-1 text-xs text-red-500">
                  {m.topic} ({m.wrongCount} wrong)
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => setShowReview(v => !v)}
          className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-muted/30 transition-colors"
        >
          <ClipboardText size={15} />
          {showReview ? 'Hide' : 'Review'} all answers
        </button>

        {showReview && (
          <div className="flex flex-col gap-3">
            {questions.map((q, i) => {
              const ua = userAnswers[i] ?? ''
              const correct = ua.toLowerCase().trim() === q.answer.toLowerCase().trim()
              return (
                <div key={i} className={`rounded-xl border p-3.5 flex flex-col gap-2 ${correct ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
                  <div className="flex items-start gap-2">
                    {correct
                      ? <CheckCircle size={15} className="mt-0.5 shrink-0 text-emerald-500" weight="fill" />
                      : <XCircle size={15} className="mt-0.5 shrink-0 text-red-500" weight="fill" />
                    }
                    <div className="text-sm text-foreground"><MathText text={q.question} /></div>
                  </div>
                  {!correct && ua && (
                    <div className="text-xs text-red-500 pl-5">Your answer: <MathText text={ua} /></div>
                  )}
                  <div className="text-xs text-muted-foreground pl-5">Correct: <MathText text={q.answer} /></div>
                  {q.explanation && (
                    <p className="text-xs text-muted-foreground/70 pl-5 italic">{q.explanation}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors"
            >
              <ArrowLeft size={14} />
              New Quiz
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main QuizSession ──────────────────────────────────────────────────────────

export function QuizSession({ courseId, courseName, topicOptions, initialQuestions, examMode, onClose, onComplete }: Props) {
  const normalizedInitial = initialQuestions?.map(normalizeQuestion)
  const [phase, setPhase] = useState<QuizPhase>(normalizedInitial ? 'quiz' : 'config')
  const [questions, setQuestions] = useState<QuizQuestion[]>(normalizedInitial ?? [])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [userAnswers, setUserAnswers] = useState<string[]>([])
  const [summary, setSummary] = useState<GradeSummary | null>(null)
  const [configState, setConfigState] = useState<ConfigState>({
    topicFilters: [], format: 'mc', questionCount: 10, difficulty: 'medium', checkTiming: 'after_each',
  })
  const [examDuration, setExamDuration] = useState(0)
  const [startTime, setStartTime] = useState<number>(0)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const onExpireRef = useRef<() => void>(() => {})

  // Sync when tutor regenerates the quiz (e.g. "add 2 more questions"): update
  // questions in place so the user doesn't have to close and reopen the split view.
  const lastInitialRef = useRef(initialQuestions)
  useEffect(() => {
    if (initialQuestions && initialQuestions !== lastInitialRef.current) {
      lastInitialRef.current = initialQuestions
      setQuestions(initialQuestions.map(normalizeQuestion))
      setCurrentIndex(0)
      setUserAnswers([])
      setSummary(null)
      setPhase('quiz')
    }
  }, [initialQuestions])

  const submitAnswers = useCallback(async (answers: string[], qs: QuizQuestion[]) => {
    setPhase('grading')
    try {
      const durationSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined
      const topicLabel = configState.topicFilters.length > 0
        ? configState.topicFilters.join(', ')
        : undefined
      const res = await fetch('/api/agents/practice-quiz/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          testType: examMode ? 'simulated_exam' : 'practice_quiz',
          questions: qs,
          userAnswers: answers,
          topicFilter: topicLabel,
          durationSeconds,
          inSession: !!normalizedInitial,  // 30/70 blend for tutor-generated quizzes
        }),
      })
      const data = await res.json() as GradeSummary & { error?: string }
      if (!res.ok || data.error || !Array.isArray(data.results) || !Array.isArray(data.missedTopics) || !Array.isArray(data.masteryUpdates)) {
        setSummary({ correctCount: 0, scorePct: 0, missedTopics: [], masteryUpdates: [], results: [] })
        setPhase('results')
        return
      }
      setSummary(data)
      setPhase('results')
      onComplete?.(data)
      // Trigger intraday scheduler rerun after simulated exam so the study
      // plan updates immediately for remaining days before the actual exam.
      if (examMode) {
        fetch('/api/agents/scheduler/rerun', { method: 'POST' }).catch(() => {})
      }
    } catch {
      setSummary({ correctCount: 0, scorePct: 0, missedTopics: [], masteryUpdates: [], results: [] })
      setPhase('results')
    }
  }, [courseId, examMode, configState.topicFilters, startTime, onComplete, normalizedInitial])

  useEffect(() => {
    onExpireRef.current = () => submitAnswers(userAnswers, questions)
  }, [submitAnswers, userAnswers, questions])

  async function handleStart(cfg: ConfigState) {
    setConfigState(cfg)
    setLoadingConfig(true)

    try {
      const topicFilter = cfg.topicFilters.length > 0
        ? cfg.topicFilters.join(', ')
        : undefined
      const endpoint = examMode ? '/api/agents/simulated-exam' : '/api/agents/practice-quiz'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          courseName,
          format: cfg.format,
          questionCount: cfg.questionCount,
          topicFilter,
          difficulty: cfg.difficulty,
        }),
      })
      const data = await res.json() as { questions: QuizQuestion[]; durationMinutes?: number; error?: string }
      if (data.error) {
        alert(data.error)
        setLoadingConfig(false)
        return
      }
      setQuestions(data.questions.map(normalizeQuestion))
      if (data.durationMinutes) setExamDuration(data.durationMinutes * 60)
      setUserAnswers([])
      setCurrentIndex(0)
      setStartTime(Date.now())
      setPhase('quiz')
    } catch {
      // stay on config
    } finally {
      setLoadingConfig(false)
    }
  }

  function handleAnswer(answer: string) {
    const newAnswers = [...userAnswers, answer]
    setUserAnswers(newAnswers)

    if (currentIndex < questions.length - 1) {
      setCurrentIndex(i => i + 1)
    } else {
      submitAnswers(newAnswers, questions)
    }
  }

  function handleRetry() {
    setPhase('config')
    setQuestions([])
    setUserAnswers([])
    setCurrentIndex(0)
    setSummary(null)
    setLoadingConfig(false)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-foreground">
            {examMode ? 'Simulated Exam' : 'Practice Quiz'}
          </span>
          <span className="text-xs text-muted-foreground truncate">{courseName}</span>
        </div>
        {phase === 'quiz' && (
          <div className="flex items-center gap-2 shrink-0">
            {examMode && examDuration > 0 && (
              <CountdownTimer totalSeconds={examDuration} onExpire={() => onExpireRef.current()} />
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              {currentIndex + 1}/{questions.length}
            </span>
          </div>
        )}
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close quiz"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {phase === 'quiz' && questions.length > 0 && (
        <div className="px-4 pt-3 shrink-0">
          <ProgressBar current={currentIndex} total={questions.length} />
        </div>
      )}

      <AnimatePresence mode="wait">
        {phase === 'config' && (
          <motion.div key="config" className="flex flex-1 flex-col overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ConfigForm
              courseName={courseName}
              topicOptions={topicOptions}
              onStart={handleStart}
              onBack={onClose}
              loading={loadingConfig}
              examMode={examMode}
            />
          </motion.div>
        )}

        {phase === 'loading' && (
          <motion.div key="loading" className="flex flex-1 flex-col items-center justify-center gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <CircleNotch size={28} className="animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Generating questions…</p>
          </motion.div>
        )}

        {phase === 'quiz' && questions[currentIndex] && (
          <motion.div key={`q-${currentIndex}`} className="flex flex-1 flex-col overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <AnimatePresence mode="wait">
              <QuestionCard
                key={currentIndex}
                question={questions[currentIndex]}
                index={currentIndex}
                total={questions.length}
                checkTiming={normalizedInitial ? 'after_each' : configState.checkTiming}
                onAnswer={handleAnswer}
              />
            </AnimatePresence>
          </motion.div>
        )}

        {phase === 'grading' && (
          <motion.div key="grading" className="flex flex-1 flex-col items-center justify-center gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <CircleNotch size={28} className="animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Grading your answers…</p>
          </motion.div>
        )}

        {phase === 'results' && summary && (
          <motion.div key="results" className="flex flex-1 flex-col overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ResultsScreen
              questions={questions}
              userAnswers={userAnswers}
              summary={summary}
              onRetry={!initialQuestions ? handleRetry : undefined}
              onClose={onClose}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
