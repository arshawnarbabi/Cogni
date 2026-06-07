'use client'

import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import {
  Cards,
  TrendUp,
  Warning,
  ClipboardText,
  GraduationCap,
  ChartBar,
  CheckCircle,
  Clock,
  ArrowDown,
  Sparkle,
} from '@phosphor-icons/react'
import { StaggerList, StaggerItem } from '@/components/ui/motion'
import { resolveIcon, resolveColor } from '@/lib/course-icons'

// ── Types ──────────────────────────────────────────────────────────────────────

type Prediction =
  | { type: 'prediction'; low: number; high: number; n: number }
  | { type: 'readiness'; label: 'on_track' | 'needs_more_time' | 'behind' | 'not_started' }

type CourseProgress = {
  course_id: string
  name: string
  icon: string | null
  icon_color: string | null
  topic_count: number
  avg_mastery: number
  trend: { date: string; mastery: number }[]
  prediction: Prediction | null
  weak_topics: { name: string; mastery: number }[]
}

type WeakArea = {
  topic_name: string
  course_name: string
  mastery: number
}

type TestResult = {
  result_id: string
  test_type: 'practice_quiz' | 'simulated_exam'
  score_pct: number | null
  question_count: number
  correct_count: number
  topic_filter: string | null
  created_at: string
  course_name: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function masteryColor(score: number) {
  if (score >= 0.75) return 'text-emerald-500'
  if (score >= 0.4) return 'text-amber-500'
  return 'text-red-500'
}

function masteryBg(score: number) {
  if (score >= 0.75) return 'bg-emerald-500'
  if (score >= 0.4) return 'bg-amber-400'
  return 'bg-red-400'
}

function masteryChartColor(score: number) {
  if (score >= 0.75) return '#10b981'
  if (score >= 0.4) return '#f59e0b'
  return '#f87171'
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

// ── Sub-components ─────────────────────────────────────────────────────────────

function MasteryBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${masteryBg(score)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function TrendSparkline({ data, score }: { data: { date: string; mastery: number }[]; score: number }) {
  const color = masteryChartColor(score)
  if (data.length < 2) {
    return (
      <div className="flex h-12 items-center justify-center">
        <span className="text-xs text-muted-foreground">Not enough data yet</span>
      </div>
    )
  }
  const gradId = `grad-${color.replace('#', '')}`
  return (
    <ResponsiveContainer width="100%" height={48}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            return (
              <div className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow">
                <span className="font-medium">{payload[0].payload.date}</span>
                <span className="ml-2 text-muted-foreground">{payload[0].value}%</span>
              </div>
            )
          }}
        />
        <Area
          type="monotone"
          dataKey="mastery"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function PredictionChip({ prediction }: { prediction: Prediction }) {
  if (prediction.type === 'prediction') {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-heading text-xl font-bold text-foreground tabular-nums">
            {prediction.low}–{prediction.high}%
          </span>
          <span className="text-xs text-muted-foreground">projected score</span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          Based on {prediction.n} past exam{prediction.n !== 1 ? 's' : ''}
        </span>
      </div>
    )
  }

  const readinessMap = {
    on_track: { icon: <CheckCircle size={13} className="text-emerald-500" weight="fill" />, text: "You're on track", color: 'text-emerald-600 dark:text-emerald-400' },
    needs_more_time: { icon: <Clock size={13} className="text-amber-500" weight="fill" />, text: 'May need more time', color: 'text-amber-600 dark:text-amber-400' },
    behind: { icon: <Warning size={13} className="text-red-500" weight="fill" />, text: 'More study needed', color: 'text-red-600 dark:text-red-400' },
    not_started: { icon: <Sparkle size={13} className="text-indigo-500" weight="fill" />, text: 'Ready to start', color: 'text-indigo-600 dark:text-indigo-400' },
  }
  const { icon, text, color } = readinessMap[prediction.label]
  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
      {icon}
      {text}
    </div>
  )
}

function CourseCard({ course }: { course: CourseProgress }) {
  const CourseIcon = resolveIcon(course.icon)
  const palette = resolveColor(course.icon_color)
  const notStarted = course.prediction?.type === 'readiness' && course.prediction.label === 'not_started'
  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${palette.bg}`}>
            <CourseIcon size={16} className={palette.icon} weight="fill" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">{course.name}</span>
            <span className="text-xs text-muted-foreground">{course.topic_count} topics</span>
          </div>
        </div>
        <span className={`font-heading text-2xl font-bold tabular-nums shrink-0 ${notStarted ? 'text-muted-foreground' : masteryColor(course.avg_mastery)}`}>
          {Math.round(course.avg_mastery * 100)}%
        </span>
      </div>

      <MasteryBar score={course.avg_mastery} />

      <div>
        <div className="mb-1 flex items-center gap-1.5">
          <TrendUp size={11} className="text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">30-day trend</span>
        </div>
        <TrendSparkline data={course.trend} score={course.avg_mastery} />
      </div>

      {course.prediction && (
        <div className="border-t border-border/50 pt-3">
          <PredictionChip prediction={course.prediction} />
        </div>
      )}

      {notStarted ? (
        <div className="border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">
            Ready to go — start a study session to begin building mastery across your {course.topic_count} topics.
          </p>
        </div>
      ) : course.weak_topics.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Weak areas</span>
          {course.weak_topics.slice(0, 3).map(t => (
            <div key={t.name} className="flex items-center gap-2">
              <ArrowDown size={10} className="text-red-400 shrink-0" weight="bold" />
              <span className="flex-1 text-xs text-foreground truncate">{t.name}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(t.mastery * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WeakAreaRow({ area }: { area: WeakArea }) {
  const pct = Math.round(area.mastery * 100)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
        <Warning size={13} className="text-red-500" weight="fill" />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-sm text-foreground truncate">{area.topic_name}</span>
        <span className="text-xs text-muted-foreground">{area.course_name}</span>
      </div>
      <span className="shrink-0 text-xs font-semibold tabular-nums text-red-500">{pct}%</span>
    </div>
  )
}

function TestResultRow({ result }: { result: TestResult }) {
  const scorePct = Math.round(result.score_pct ?? 0)
  const scoreColor = scorePct >= 75 ? 'text-emerald-500' : scorePct >= 50 ? 'text-amber-500' : 'text-red-500'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${result.test_type === 'simulated_exam' ? 'bg-purple-500/10' : 'bg-primary/10'}`}>
        {result.test_type === 'simulated_exam'
          ? <GraduationCap size={14} className="text-purple-500" weight="fill" />
          : <ClipboardText size={14} className="text-primary" weight="fill" />
        }
      </div>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-sm text-foreground truncate">
          {result.test_type === 'simulated_exam' ? 'Simulated Exam' : 'Practice Quiz'}
          {result.course_name && <span className="ml-1 text-muted-foreground">· {result.course_name}</span>}
        </span>
        <span className="text-xs text-muted-foreground">
          {result.correct_count}/{result.question_count} correct · {timeAgo(result.created_at)}
        </span>
      </div>
      <span className={`font-heading text-base font-bold tabular-nums shrink-0 ${scoreColor}`}>{scorePct}%</span>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function ProgressClient({
  courses,
  weakAreas,
  dueToday,
  testResults,
  standingSlot,
}: {
  courses: CourseProgress[]
  weakAreas: WeakArea[]
  dueToday: number
  testResults: TestResult[]
  standingSlot?: React.ReactNode
}) {
  const hasAnything = courses.length > 0 || testResults.length > 0

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-2xl font-semibold text-foreground">Progress</h1>
            <p className="mt-1 text-sm text-muted-foreground">Mastery, trends, and exam readiness across all courses.</p>
          </div>
          {dueToday > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 shrink-0">
              <Cards size={15} className="text-primary" weight="fill" />
              <span className="text-sm font-semibold text-primary">{dueToday} due today</span>
            </div>
          )}
        </div>

        {/* Semester standing (S15) */}
        {standingSlot}

        {!hasAnything ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <ChartBar size={36} className="text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No data yet. Study a bit and come back!</p>
          </div>
        ) : (
          <>
            {courses.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Courses</h2>
                <StaggerList className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {courses.map(course => (
                    <StaggerItem key={course.course_id}>
                      <CourseCard course={course} />
                    </StaggerItem>
                  ))}
                </StaggerList>
              </div>
            )}

            {weakAreas.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Top weak areas</h2>
                <StaggerList className="flex flex-col gap-2">
                  {weakAreas.map((area, i) => (
                    <StaggerItem key={`${area.topic_name}-${i}`}>
                      <WeakAreaRow area={area} />
                    </StaggerItem>
                  ))}
                </StaggerList>
              </div>
            )}

            {testResults.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Test history</h2>
                <StaggerList className="flex flex-col gap-2">
                  {testResults.map(r => (
                    <StaggerItem key={r.result_id}>
                      <TestResultRow result={r} />
                    </StaggerItem>
                  ))}
                </StaggerList>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
