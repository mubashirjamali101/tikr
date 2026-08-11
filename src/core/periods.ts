/**
 * Calendar arithmetic for report windows.
 *
 * One derivation for days, weeks and months rather than three ad-hoc date paths, because the cases
 * that break are always the same three: the month wrap, the year wrap, and which day a week starts
 * on. Pure string in, string out, so it is testable without a clock.
 */

export type Unit = 'day' | 'week' | 'month'
export type WeekDay = 'sunday' | 'monday'

const DAY = 86_400_000

function parse(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Today in the local timezone, `YYYY-MM-DD`. */
export function today(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** First day of the week containing `day`. */
export function weekStart(day: string, startOn: WeekDay = 'monday'): string | null {
  const date = parse(day)
  if (date === null) return null
  const offset = startOn === 'monday' ? (date.getUTCDay() + 6) % 7 : date.getUTCDay()
  return format(new Date(date.getTime() - offset * DAY))
}

/** First day of the month containing `day`. */
export function monthStart(day: string): string | null {
  return parse(day) === null ? null : `${day.slice(0, 7)}-01`
}

/** The bucket key a day belongs to, for a report grouped by `unit`. */
export function periodKey(day: string, unit: Unit, startOn: WeekDay = 'monday'): string | null {
  if (unit === 'day') return parse(day) === null ? null : day
  if (unit === 'week') return weekStart(day, startOn)
  return monthStart(day)
}

/**
 * First day of the window covering the most recent `count` periods, the last being the current one.
 *
 * A count of zero or one both mean "the period we are in now": zero is what a user types when they
 * mean today, and rejecting it would silently widen their window.
 */
export function lastPeriodsSince(
  unit: Unit,
  count: number,
  from: string,
  startOn: WeekDay = 'monday',
): string | null {
  const back = Math.max(0, Math.floor(count) - 1)
  if (unit === 'day') {
    const date = parse(from)
    return date === null ? null : format(new Date(date.getTime() - back * DAY))
  }
  if (unit === 'week') {
    const start = weekStart(from, startOn)
    const date = start === null ? null : parse(start)
    return date === null ? null : format(new Date(date.getTime() - back * 7 * DAY))
  }
  const start = monthStart(from)
  if (start === null) return null
  const year = Number(start.slice(0, 4))
  const month = Number(start.slice(5, 7)) - 1 - back
  const shifted = new Date(Date.UTC(year, month, 1))
  return format(shifted)
}

/** Human label for a period bucket key. */
export function periodLabel(key: string, unit: Unit): string {
  if (unit === 'week') return `week of ${key}`
  if (unit === 'month') return key.slice(0, 7)
  return key
}
