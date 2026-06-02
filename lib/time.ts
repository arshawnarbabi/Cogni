function datePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '01'
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
  }
}

export function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const { year, month, day } = datePartsInTimeZone(date, timeZone)
  return `${year}-${month}-${day}`
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().split('T')[0]
}

/** True if `tz` is a valid IANA timezone string usable by Intl. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Offset between `tz` local wall time and UTC at the given instant, in ms.
 * Positive when the zone is ahead of UTC (e.g. +3600000 for CET in winter).
 */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(instant)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  // Intl renders hour "24" at midnight in some engines; normalize to 0.
  const hour = map.hour === '24' ? 0 : Number(map.hour)
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second)
  )
  return asUtc - instant.getTime()
}

/**
 * Convert a wall-clock time (date + hour/minute) in `timeZone` to the UTC instant
 * at which it occurs. Handles positive/negative offsets and DST transitions.
 */
export function zonedWallTimeToUtc(
  dateKey: string,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  // First guess: treat the wall time as if it were UTC, then subtract the zone offset.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const offset1 = tzOffsetMs(guess, timeZone)
  let result = new Date(guess.getTime() - offset1)
  // Refine once: near DST boundaries the offset at the result instant can differ.
  const offset2 = tzOffsetMs(result, timeZone)
  if (offset2 !== offset1) {
    result = new Date(guess.getTime() - offset2)
  }
  return result
}

/** UTC instant for the start (00:00) of the given local date in `timeZone`. */
export function startOfLocalDayUtc(dateKey: string, timeZone: string): Date {
  return zonedWallTimeToUtc(dateKey, 0, 0, timeZone)
}

/** UTC instant for the exclusive end of the given local date (i.e. next day 00:00) in `timeZone`. */
export function endOfLocalDayUtc(dateKey: string, timeZone: string): Date {
  return startOfLocalDayUtc(addDaysToDateKey(dateKey, 1), timeZone)
}

/**
 * 8am–10pm local study window for the given local date, expressed as UTC instants.
 * Start/end hours match the calendar scheduler's STUDY_START_HOUR / STUDY_END_HOUR.
 */
export function studyWindowUtc(
  dateKey: string,
  timeZone: string,
  startHour = 8,
  endHour = 22
): { start: Date; end: Date } {
  return {
    start: zonedWallTimeToUtc(dateKey, startHour, 0, timeZone),
    end: zonedWallTimeToUtc(dateKey, endHour, 0, timeZone),
  }
}
