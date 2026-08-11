import { type LimitState, emptyLimits } from './limits.js'
import { type OtelState, emptyOtel } from './otel.js'

export { type OtelState, emptyOtel }

/** Token counts for one (bucket, model) pair. All fields are cumulative token counts. */
export interface Totals {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  messages: number
}

export function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 0 }
}

export function addTotals(target: Totals, delta: Totals): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheWrite5m += delta.cacheWrite5m
  target.cacheWrite1h += delta.cacheWrite1h
  target.cacheRead += delta.cacheRead
  target.messages += delta.messages
}

/** Total tokens across every category - the headline "how much did I use" number. */
export function grandTotal(t: Totals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}

/**
 * Input and output only, with both cache categories left out.
 *
 * Cache reads outnumber output by two orders of magnitude in normal Claude Code use, so the grand
 * total mostly measures how large the context was rather than how much work was done. This is the
 * figure to compare one session against another by, which is why it sits beside the total
 * everywhere rather than replacing it.
 */
export function nonCacheTotal(t: Totals): number {
  return t.input + t.output
}

/** The same bucket with both cache categories zeroed, for pricing the input-and-output view. */
export function withoutCache(t: Totals): Totals {
  return { ...t, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }
}

/** One assistant message's usage, extracted from a transcript line. */
export interface UsageRecord {
  messageId: string
  /** API request id, absent on older entries. Part of the series key so a retry is not a duplicate. */
  requestId: string | null
  model: string
  /** Billed at the fast-mode rate, which is a multiple of the standard rate. */
  fast: boolean
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** Local hour, `YYYY-MM-DDTHH`. */
  hour: string
  /** The message's own timestamp, ISO. */
  at: string
  /** Everything the model read for this request: input plus cache reads plus cache writes. */
  contextTokens: number
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

/**
 * A running total already counted for one series inside a file.
 *
 * Every provider reports cumulative figures for some series - a message id for Claude Code, the
 * session for Codex, a model for Copilot - so `counted` records what has been folded in and a
 * later, larger snapshot contributes only the increase. `day`, `model` and `project` are pinned at
 * first sight so a series that spans midnight stays in one bucket. See docs/LESSONS.md.
 */
export interface SeriesState {
  id: string
  day: string
  /** Qualified `provider/model`. */
  model: string
  project: string
  counted: Totals
}

export interface FileState {
  /** Byte offset of the first not-yet-ingested byte. */
  offset: number
  /** File size at that offset, used to detect truncation or replacement. */
  size: number
  /** Live series in this file, keyed by series id. */
  series: Record<string, SeriesState>
}

/**
 * Transcripts this tool counted that Claude Code has since deleted.
 *
 * Claude Code removes session files older than `cleanupPeriodDays` (default 30) at startup, so the
 * set of files on disk shrinks every day. Their tokens stay in our totals - this is how many
 * sources have gone away, recorded so the loss of the underlying evidence is visible rather than
 * silent.
 */
export interface PruneState {
  count: number
  lastAt: string | null
}

export interface State {
  version: number
  createdAt: string
  lastScanAt: string | null
  /** Times a transcript shrank underneath us and we resynced without ingesting. */
  resyncs: number
  pruned: PruneState
  files: Record<string, FileState>
  /** day (YYYY-MM-DD) -> model -> totals */
  daily: Record<string, Record<string, Totals>>
  /**
   * hour (YYYY-MM-DDTHH, local) -> model -> totals.
   *
   * A second view of the same tokens as `daily`, at the resolution the five-hour block model and
   * the time-of-day views need. Additive like every other aggregate, and deliberately excluded from
   * `recordedTokens`: counting the same tokens twice would make the write-regression guard
   * meaningless.
   */
  hourly: Record<string, Record<string, Totals>>
  /** encoded project directory name -> model -> totals */
  projects: Record<string, Record<string, Totals>>
  /** Newest message timestamp seen, ISO. Gives the active block sub-hour precision. */
  lastActivityAt: string | null
  limits: LimitState
  otel: OtelState
}

export const STATE_VERSION = 3

/**
 * Total tokens this tool has recorded.
 *
 * Derived from the daily buckets, which are only ever added to. Used as the integrity measure that
 * guards against a write shrinking the record - see `saveState`.
 */
export function recordedTokens(state: State): number {
  let sum = 0
  for (const byModel of Object.values(state.daily)) {
    for (const totals of Object.values(byModel)) sum += grandTotal(totals)
  }
  return sum
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    lastScanAt: null,
    resyncs: 0,
    pruned: { count: 0, lastAt: null },
    files: {},
    daily: {},
    hourly: {},
    projects: {},
    lastActivityAt: null,
    limits: emptyLimits(),
    otel: emptyOtel(),
  }
}
