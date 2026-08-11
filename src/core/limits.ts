/**
 * Usage limit events, as Claude Code records them in a transcript.
 *
 * When a request is refused for hitting the subscription limit, the transcript carries an error
 * message entry naming the limit and, after a pipe, the epoch at which it resets. That is the only
 * first-hand evidence of a limit this tool can see, which makes it the honest basis for the
 * observed ceiling in `ceiling.ts`. Everything else in the field guesses plan numbers.
 *
 * Verification status: the marker text below is taken from ccusage's parser. Of the 217 local
 * transcripts checked on 2026-08-11, 14 carried `isApiErrorMessage` and 8 had it true, but all 8
 * were connection or authentication errors. So the marker itself is **unverified against real local
 * data**. The parser is therefore written to treat absence as entirely normal: no warning, no
 * error, no inference. Replace the fixture in `test/limits.test.ts` with a real line when one is
 * seen, and record any difference in docs/LESSONS.md.
 */

export interface LimitEvent {
  /** When the limit was hit, ISO. */
  at: string
  /** When it resets, ISO, or null when the message carried no parseable reset time. */
  resetAt: string | null
}

export interface LimitState {
  /** Newest last. Capped at `MAX_LIMIT_EVENTS`; older ones are counted in `dropped`. */
  events: LimitEvent[]
  dropped: number
}

export function emptyLimits(): LimitState {
  return { events: [], dropped: 0 }
}

/** Limit events are rare, so this cap is generous. It exists to bound state, not to discard. */
export const MAX_LIMIT_EVENTS = 200

const MARKER = 'Claude AI usage limit reached'

/** Epochs at or above this are milliseconds; below it, seconds. 1e12 ms is the year 2001. */
const MILLISECOND_EPOCH_FLOOR = 1e12

/**
 * Read the reset epoch that follows the marker.
 *
 * The line is scanned as text rather than walked as JSON: the message content is nested differently
 * across Claude Code versions, and the marker plus a pipe plus digits is stable in a way the
 * surrounding shape is not.
 */
export function parseResetTime(line: string): string | null {
  const marker = line.indexOf(MARKER)
  if (marker === -1) return null
  const pipe = line.indexOf('|', marker)
  if (pipe === -1) return null

  let end = pipe + 1
  while (end < line.length && line[end]! >= '0' && line[end]! <= '9') end += 1
  if (end === pipe + 1) return null

  const epoch = Number(line.slice(pipe + 1, end))
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  const millis = epoch >= MILLISECOND_EPOCH_FLOOR ? epoch : epoch * 1000
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/**
 * A limit event for this line, or null when it is not one.
 *
 * Gated on `isApiErrorMessage` so that a transcript merely quoting the marker - a conversation
 * about limits, or a tool result containing this very file - is not counted as having hit one.
 */
export function parseLimitEvent(line: string, at: string): LimitEvent | null {
  if (!line.includes('"isApiErrorMessage":true')) return null
  if (!line.includes(MARKER)) return null
  return { at, resetAt: parseResetTime(line) }
}

/**
 * Record an event, newest last, ignoring one already recorded.
 *
 * Re-ingesting a line must not append a second copy, so the same instant is treated as the same
 * event. Returns whether anything was added.
 */
export function recordLimitEvent(state: LimitState, event: LimitEvent): boolean {
  if (state.events.some((existing) => existing.at === event.at)) return false
  state.events.push(event)
  state.events.sort((left, right) => left.at.localeCompare(right.at))
  while (state.events.length > MAX_LIMIT_EVENTS) {
    state.events.shift()
    state.dropped += 1
  }
  return true
}
