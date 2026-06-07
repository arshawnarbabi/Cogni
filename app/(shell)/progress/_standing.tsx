import { computeSemesterStanding, type CourseVerdict } from '@/lib/semester'

// Semester standing (S15) — server-rendered: one honest verdict per course
// with the single most important "why" line. The blunt advisor view.

const VERDICT_STYLES: Record<CourseVerdict, { label: string; chip: string; border: string }> = {
  on_track: {
    label: 'On track',
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    border: 'border-border',
  },
  at_risk: {
    label: 'At risk',
    chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    border: 'border-amber-300/60 dark:border-amber-700/60',
  },
  critical: {
    label: 'Critical',
    chip: 'bg-red-500/10 text-red-600 dark:text-red-400',
    border: 'border-red-300/60 dark:border-red-800/60',
  },
}

export async function SemesterStanding({ userId }: { userId: string }) {
  const standing = await computeSemesterStanding(userId).catch(() => [])
  if (standing.length === 0) return null

  // Worst first — the course that needs attention leads.
  const order: Record<CourseVerdict, number> = { critical: 0, at_risk: 1, on_track: 2 }
  const sorted = [...standing].sort((a, b) => order[a.verdict] - order[b.verdict])
  const alarms = sorted.filter(s => s.verdict !== 'on_track').length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">Semester standing</h2>
        <span className="text-[11px] text-muted-foreground">
          {alarms === 0 ? 'All courses on track' : `${alarms} course${alarms === 1 ? '' : 's'} need${alarms === 1 ? 's' : ''} attention`}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map(s => {
          const style = VERDICT_STYLES[s.verdict]
          return (
            <div key={s.course_id} className={`flex flex-col gap-1.5 rounded-xl border ${style.border} bg-card px-4 py-3`}>
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-foreground">{s.course_name}</p>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.chip}`}>{style.label}</span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">{s.reason}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/80">
                {s.grade && <span>grade {s.grade.current_pct}%</span>}
                {s.next_exam && <span>exam in {s.next_exam.days_away}d · {s.next_exam.readiness_pct}% ready</span>}
                {s.overdue_count > 0 && <span className="text-red-500">{s.overdue_count} overdue</span>}
                <span>{s.reviews_14d} reviews / 14d</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
