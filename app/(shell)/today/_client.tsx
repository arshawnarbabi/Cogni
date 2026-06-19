'use client'

import { useState, Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  Tray,
  ArrowRight,
  Cards,
  BookOpen,
  CheckCircle,
  Fire,
  Warning,
  Key,
  ClockCountdown,
  GraduationCap,
  UploadSimple,
  X,
  Lightbulb,
  ClipboardText,
  CalendarBlank,
  CaretDown,
  CaretUp,
} from '@phosphor-icons/react'
import { StaggerList, StaggerItem, ease } from '@/components/ui/motion'
import { resolveColor } from '@/lib/course-icons'
import type { TaskItem } from '@/lib/agents/scheduler'
import type { ActiveNudge } from '@/lib/agents/nudge'

type CourseIconMap = Record<string, { icon: string | null; icon_color: string | null }>

function courseColor(courseId: string, map: CourseIconMap) {
  return resolveColor(map[courseId]?.icon_color ?? null)
}

function InsightCard({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
      <Lightbulb size={16} className="mt-0.5 shrink-0 text-primary" weight="fill" />
      <p className="text-sm text-foreground leading-snug">{text}</p>
    </div>
  )
}

function FlashcardTaskCard({ task, completed, onComplete, courseIconMap }: {
  task: Extract<TaskItem, { type: 'flashcard_review' }>
  completed: boolean
  onComplete: () => void
  courseIconMap: CourseIconMap
}) {
  const router = useRouter()
  const color = courseColor(task.course_id, courseIconMap)
  return (
    <motion.div
      layout
      className={`rounded-xl border border-border bg-card transition-opacity ${completed ? 'opacity-50' : ''}`}
      whileHover={completed ? {} : { scale: 1.003, transition: { duration: 0.15, ease } }}
      whileTap={completed ? {} : { scale: 0.997 }}
    >
      <div className="flex items-center gap-4 p-4">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${color.bg}`}>
          <Cards size={18} className={color.icon} weight="fill" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{task.course_name}</span>
          <span className="text-xs text-muted-foreground">
            {task.reason ?? (task.card_count > 0 ? `${task.card_count} cards due` : 'Flashcard review')} · ~{task.duration_minutes} min
          </span>
        </div>
        {completed || task.card_count === 0 ? (
          // Zero due cards = nothing to review right now; show it done rather than a
          // dead "No cards yet" sitting in the plan.
          <CheckCircle size={22} className="shrink-0 text-emerald-500" weight="fill" />
        ) : (
          <button
            onClick={() => {
              router.push(`/review?course=${task.course_id}`)
              onComplete()
            }}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            Study <ArrowRight size={13} />
          </button>
        )}
      </div>
    </motion.div>
  )
}

function QuizTaskCard({ task, completed, onComplete, courseIconMap }: {
  task: Extract<TaskItem, { type: 'practice_quiz' }>
  completed: boolean
  onComplete: () => void
  courseIconMap: CourseIconMap
}) {
  const router = useRouter()
  const color = courseColor(task.course_id, courseIconMap)
  return (
    <motion.div
      layout
      className={`rounded-xl border border-border bg-card transition-opacity ${completed ? 'opacity-50' : ''}`}
      whileHover={completed ? {} : { scale: 1.003, transition: { duration: 0.15, ease } }}
      whileTap={completed ? {} : { scale: 0.997 }}
    >
      <div className="flex items-center gap-4 p-4">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${color.bg}`}>
          <ClipboardText size={18} className={color.icon} weight="fill" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{task.course_name}</span>
          <span className="text-xs text-muted-foreground">{task.reason}</span>
        </div>
        {completed ? (
          <CheckCircle size={22} className="shrink-0 text-emerald-500" weight="fill" />
        ) : (
          <button
            onClick={() => {
              router.push(`/courses/${task.course_id}`)
              onComplete()
            }}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/50 transition-colors shrink-0"
          >
            Quiz <ArrowRight size={13} />
          </button>
        )}
      </div>
    </motion.div>
  )
}

function NudgeCard({ nudge, onDismiss }: { nudge: ActiveNudge; onDismiss: () => void }) {
  const [loading, setLoading] = useState(false)

  const iconMap: Record<string, React.ReactNode> = {
    homework_completion: <ClockCountdown size={16} className="text-red-500" weight="fill" />,
    material_gap: <BookOpen size={16} className="text-amber-500" weight="fill" />,
    upload_content: <UploadSimple size={16} className="text-amber-500" weight="fill" />,
  }
  const bgMap: Record<string, string> = {
    homework_completion: 'bg-red-500/10',
    material_gap: 'bg-amber-500/10',
    upload_content: 'bg-amber-500/10',
  }
  const borderMap: Record<string, string> = {
    homework_completion: 'border-red-200 dark:border-red-900/40',
    material_gap: 'border-amber-200 dark:border-amber-900/40',
    upload_content: 'border-amber-200 dark:border-amber-900/40',
  }

  const icon = iconMap[nudge.type] ?? <Warning size={16} className="text-muted-foreground" weight="fill" />
  const bg = bgMap[nudge.type] ?? 'bg-muted/40'
  const border = borderMap[nudge.type] ?? 'border-border'

  async function handleAction(action: 'resolve' | 'snooze') {
    setLoading(true)
    try {
      await fetch(`/api/nudges/${nudge.nudge_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      onDismiss()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${border}`}>
      <div className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${bg}`}>
        {icon}
      </div>
      <span className="flex-1 text-sm text-foreground leading-snug">{nudge.content}</span>
      {nudge.tier !== 'critical' && (
        <button
          disabled={loading}
          onClick={() => handleAction(nudge.tier === 'recurring' ? 'resolve' : 'snooze')}
          aria-label={nudge.tier === 'recurring' ? 'Mark done' : 'Snooze'}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function HomeworkTaskCard({ task, completed, onComplete, courseIconMap }: {
  task: Extract<TaskItem, { type: 'homework' }>
  completed: boolean
  onComplete: () => void
  courseIconMap: CourseIconMap
}) {
  const color = courseColor(task.course_id, courseIconMap)
  return (
    <motion.div
      layout
      className={`rounded-xl border transition-opacity ${
        task.overdue
          ? 'border-red-200 bg-red-50/50 dark:border-red-900/40 dark:bg-red-950/20'
          : 'border-border bg-card'
      } ${completed ? 'opacity-50' : ''}`}
      whileHover={completed ? {} : { scale: 1.003, transition: { duration: 0.15, ease } }}
      whileTap={completed ? {} : { scale: 0.997 }}
    >
      <div className="flex items-center gap-4 p-4">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${task.overdue ? 'bg-red-500/10' : color.bg}`}>
          <ClockCountdown size={18} className={task.overdue ? 'text-red-500' : color.icon} weight="fill" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{task.title}</span>
          <span className={`text-xs ${task.overdue ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
            {task.reason ?? `${task.overdue ? 'Overdue' : 'Due today'} · ${task.course_name}`}
          </span>
        </div>
        {completed ? (
          <CheckCircle size={22} className="shrink-0 text-emerald-500" weight="fill" />
        ) : (
          <button
            onClick={onComplete}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/50 transition-colors shrink-0"
          >
            Done <CheckCircle size={13} />
          </button>
        )}
      </div>
    </motion.div>
  )
}

function WeeklySchedule({ schedule }: { schedule: { date: string; tasks: TaskItem[] }[] }) {
  const [expanded, setExpanded] = useState(false)

  if (schedule.length === 0) return null

  const displayDays = expanded ? schedule : schedule.slice(0, 3)

  function formatDate(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00')
    const today = new Date()
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
    if (diff === 1) return 'Tomorrow'
    const day = d.toLocaleDateString(undefined, { weekday: 'short' })
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${day}, ${date}`
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <CalendarBlank size={14} className="text-muted-foreground" weight="fill" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">This Week</h2>
      </div>

      <div className="flex flex-col gap-2">
        {displayDays.map(({ date, tasks }) => {
          const flashcardTasks = tasks.filter(t => t.type === 'flashcard_review') as Extract<TaskItem, { type: 'flashcard_review' }>[]
          const hwTasks = tasks.filter(t => t.type === 'homework') as Extract<TaskItem, { type: 'homework' }>[]
          const totalCards = flashcardTasks.reduce((sum, t) => sum + t.card_count, 0)
          const totalMins = flashcardTasks.reduce((sum, t) => sum + t.duration_minutes, 0)

          return (
            <div key={date} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex w-24 shrink-0 flex-col">
                <span className="text-xs font-semibold text-foreground">{formatDate(date)}</span>
              </div>
              <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1">
                {totalCards > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Cards size={11} className="text-primary" />
                    {totalCards} cards · ~{totalMins} min
                  </span>
                )}
                {hwTasks.map(t => (
                  <span key={t.assignment_id} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ClockCountdown size={11} className="text-amber-500" />
                    {t.title}
                  </span>
                ))}
                {totalCards === 0 && hwTasks.length === 0 && (
                  <span className="text-xs text-muted-foreground/60">Nothing scheduled</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {schedule.length > 3 && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <CaretUp size={11} /> : <CaretDown size={11} />}
          {expanded ? 'Show less' : `Show ${schedule.length - 3} more days`}
        </button>
      )}
    </div>
  )
}

export function TodayClient({
  greeting,
  tasks,
  upcomingSchedule,
  pendingCount,
  streak,
  hasApiKey,
  keyHealth,
  missingSyllabus,
  activeNudge: initialNudge,
  courseIconMap,
}: {
  greeting: string
  tasks: TaskItem[]
  upcomingSchedule: { date: string; tasks: TaskItem[] }[]
  pendingCount: number
  streak: number
  hasApiKey: boolean
  keyHealth?: { anthropic: string | null; openai: string | null }
  missingSyllabus: { course_id: string; name: string }[]
  activeNudge: ActiveNudge | null
  courseIconMap: CourseIconMap
}) {
  const router = useRouter()
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [activeNudge, setActiveNudge] = useState<ActiveNudge | null>(initialNudge)

  const insightTask = tasks.find(t => t.type === 'insight') as Extract<TaskItem, { type: 'insight' }> | undefined
  const studyTasks = tasks.filter(t => t.type === 'flashcard_review') as Extract<TaskItem, { type: 'flashcard_review' }>[]
  const quizTasks = tasks.filter(t => t.type === 'practice_quiz') as Extract<TaskItem, { type: 'practice_quiz' }>[]
  const hwTasks = tasks.filter(t => t.type === 'homework') as Extract<TaskItem, { type: 'homework' }>[]

  const actionableTasks = tasks.filter(t => t.type !== 'insight')

  // Stable identity for a task — array indices desync when router.refresh()
  // recomputes the task list (day rollover, plan re-runs), which made
  // checkmarks jump onto the wrong cards.
  function taskKey(task: TaskItem): string {
    if (task.type === 'homework') return `homework:${task.assignment_id}`
    if (task.type === 'insight') return `insight:${task.order}`
    return `${task.type}:${task.course_id}`
  }

  // A homework task counts as completed if it was already marked complete server-side OR optimistically by this session
  function isTaskCompleted(task: TaskItem): boolean {
    if (task.type === 'homework' && (task as Extract<TaskItem, { type: 'homework' }>).completion_status === 'complete') return true
    return completed.has(taskKey(task))
  }

  const completedCount = actionableTasks.reduce((n, t) => n + (isTaskCompleted(t) ? 1 : 0), 0)
  const total = actionableTasks.length

  async function markDone(task: TaskItem, assignmentId?: string) {
    setCompleted(prev => new Set([...prev, taskKey(task)]))
    // No assignmentId = flashcard/quiz task that navigates elsewhere.
    // Don't refresh — it interferes with the pending <Link> navigation.
    if (!assignmentId) {
      fetch('/api/user/streak', { method: 'POST' }).catch(() => {})
      return
    }
    await Promise.all([
      fetch('/api/assignments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }).catch(() => {}),
      fetch('/api/user/streak', { method: 'POST' }).catch(() => {}),
    ])
    router.refresh()
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* Header + streak */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">{greeting}</h1>
          {total > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {completedCount === total
                ? "You're all done for today."
                : `${total - completedCount} task${total - completedCount === 1 ? '' : 's'} left today.`}
            </p>
          )}
        </div>
        {streak > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 dark:border-amber-900/50 dark:bg-amber-950/30">
            <Fire size={14} className="text-amber-500" weight="fill" />
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">{streak} day streak</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              animate={{ width: `${(completedCount / total) * 100}%` }}
              transition={{ duration: 0.4, ease }}
            />
          </div>
          <span className="text-xs tabular-nums text-muted-foreground shrink-0">{completedCount}/{total}</span>
        </div>
      )}

      {/* AI Insight */}
      {insightTask && <InsightCard text={insightTask.text} />}

      {/* System state: a saved key is BROKEN (rejected by the provider / out of
          credits). Detected by the AI-call circuit breaker (R5) — without this, a
          dead key looks like a mysteriously broken app. */}
      {hasApiKey && keyHealth?.anthropic && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/30">
          <Key size={18} className="shrink-0 text-red-500" weight="fill" />
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-sm font-semibold text-red-800 dark:text-red-300">
              {keyHealth.anthropic === 'no_credits' ? 'Your Anthropic key is out of credits' : 'Your Anthropic key was rejected'}
            </span>
            <span className="text-xs text-red-600/80 dark:text-red-400/80">
              {keyHealth.anthropic === 'no_credits'
                ? 'The tutor and AI features are paused until you add credits to your Anthropic account.'
                : 'It may have been revoked. Re-enter a valid key in Settings to restore AI features.'}
            </span>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-200 transition-colors dark:bg-red-900/40 dark:text-red-300"
          >
            Fix
          </Link>
        </div>
      )}
      {keyHealth?.openai && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-950/30">
          <Key size={18} className="shrink-0 text-amber-500" weight="fill" />
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {keyHealth.openai === 'no_credits' ? 'Your OpenAI key is out of credits' : 'Your OpenAI key was rejected'}
            </span>
            <span className="text-xs text-amber-600/80 dark:text-amber-400/80">Semantic search over your materials is degraded until the key is fixed in Settings.</span>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-200 transition-colors dark:bg-amber-900/40 dark:text-amber-300"
          >
            Fix
          </Link>
        </div>
      )}

      {/* System state: API key missing */}
      {!hasApiKey && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/30">
          <Key size={18} className="shrink-0 text-red-500" weight="fill" />
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-sm font-semibold text-red-800 dark:text-red-300">Anthropic API key missing</span>
            <span className="text-xs text-red-600/80 dark:text-red-400/80">AI features are disabled until you add a key in Settings.</span>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-200 transition-colors dark:bg-red-900/40 dark:text-red-300"
          >
            Fix
          </Link>
        </div>
      )}

      {/* System state: syllabus missing per course */}
      {missingSyllabus.map(course => (
        <div key={course.course_id} className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-950/30">
          <Warning size={18} className="shrink-0 text-amber-500" weight="fill" />
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-300 truncate">{course.name} — no syllabus</span>
            <span className="text-xs text-amber-600/80 dark:text-amber-400/80">Upload a syllabus so Cogni can build your study plan.</span>
          </div>
          <Link
            href="/inbox"
            className="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-200 transition-colors dark:bg-amber-900/40 dark:text-amber-300"
          >
            Upload
          </Link>
        </div>
      ))}

      {/* Nudge card */}
      {activeNudge && (
        <NudgeCard nudge={activeNudge} onDismiss={() => setActiveNudge(null)} />
      )}

      {/* Inbox nudge */}
      {pendingCount > 0 && (
        <Link
          href="/inbox"
          className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 hover:bg-muted/60 transition-colors"
        >
          <Tray size={18} className="shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm text-foreground">
            {pendingCount} inbox item{pendingCount > 1 ? 's' : ''} need{pendingCount === 1 ? 's' : ''} review
          </span>
          <ArrowRight size={16} className="text-muted-foreground" />
        </Link>
      )}

      {/* Today's task sections, ordered by their most-urgent item — so an overdue
          assignment or an exam-imminent quiz leads, instead of always sitting under
          flashcards. */}
      {(() => {
        const maxPrio = (ts: { priority_score?: number }[]) =>
          ts.reduce((m, t) => Math.max(m, t.priority_score ?? 0), 0)
        const sections: { key: string; prio: number; node: ReactNode }[] = []

        if (studyTasks.length > 0) sections.push({ key: 'study', prio: maxPrio(studyTasks), node: (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <GraduationCap size={14} className="text-muted-foreground" weight="fill" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Study</h2>
            </div>
            <StaggerList className="flex flex-col gap-3">
              {studyTasks.sort((a, b) => a.order - b.order).map(task => (
                <StaggerItem key={task.course_id}>
                  <FlashcardTaskCard
                    task={task}
                    courseIconMap={courseIconMap}
                    completed={completed.has(taskKey(task))}
                    onComplete={() => markDone(task)}
                  />
                </StaggerItem>
              ))}
            </StaggerList>
          </div>
        ) })

        if (quizTasks.length > 0) sections.push({ key: 'practice', prio: maxPrio(quizTasks), node: (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ClipboardText size={14} className="text-muted-foreground" weight="fill" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Practice</h2>
            </div>
            <StaggerList className="flex flex-col gap-3">
              {quizTasks.sort((a, b) => a.order - b.order).map((task, i) => (
                <StaggerItem key={task.course_id + i}>
                  <QuizTaskCard
                    task={task}
                    courseIconMap={courseIconMap}
                    completed={completed.has(taskKey(task))}
                    onComplete={() => markDone(task)}
                  />
                </StaggerItem>
              ))}
            </StaggerList>
          </div>
        ) })

        if (hwTasks.length > 0) sections.push({ key: 'homework', prio: maxPrio(hwTasks), node: (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ClockCountdown size={14} className="text-muted-foreground" weight="fill" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Homework</h2>
            </div>
            <StaggerList className="flex flex-col gap-3">
              {hwTasks.sort((a, b) => a.order - b.order).map(task => (
                <StaggerItem key={task.assignment_id}>
                  <HomeworkTaskCard
                    task={task}
                    courseIconMap={courseIconMap}
                    completed={isTaskCompleted(task)}
                    onComplete={() => markDone(task, task.assignment_id)}
                  />
                </StaggerItem>
              ))}
            </StaggerList>
          </div>
        ) })

        return sections
          .sort((a, b) => b.prio - a.prio)
          .map(s => <Fragment key={s.key}>{s.node}</Fragment>)
      })()}

      {/* Weekly schedule */}
      <WeeklySchedule schedule={upcomingSchedule} />

      {/* Empty state */}
      {actionableTasks.length === 0 && missingSyllabus.length === 0 && hasApiKey && !activeNudge && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
          <BookOpen size={36} className="text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">You&apos;re all caught up for today.</p>
          <p className="text-xs text-muted-foreground/60">New cards and assignments will appear here when they&apos;re due.</p>
        </div>
      )}
    </div>
  )
}
