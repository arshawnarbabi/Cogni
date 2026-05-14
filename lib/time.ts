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
