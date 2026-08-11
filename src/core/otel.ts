import type { Totals } from './types.js'

/**
 * Usage reported by Claude Code's own OpenTelemetry export.
 *
 * Kept in its own section and **never added to the transcript totals**: the two sources describe
 * the same tokens, so summing them would double every number. Transcripts remain the system of
 * record because they cover history retroactively; telemetry adds what transcripts cannot supply -
 * Anthropic's own cost figure, a main-vs-subagent split, and push-based freshness.
 */
export interface OtelState {
  /** Set once anything has been received, so the report can tell "off" from "on but idle". */
  active: boolean
  lastEventAt: string | null
  /** day (YYYY-MM-DD) -> model -> totals */
  daily: Record<string, Record<string, Totals>>
  /** model -> USD, as calculated by Claude Code itself. */
  costUsd: Record<string, number>
  /** query_source (main | subagent | auxiliary) -> total tokens */
  bySource: Record<string, number>
  /** Last value seen per cumulative series, so running totals can be differenced. */
  cumulative: Record<string, number>
  /**
   * Non-token counters Claude Code also exports: lines of code, commits, pull requests, sessions,
   * tool decisions. Kept as `metric -> day -> attribute signature -> value` so a new upstream
   * metric needs no schema change. These are counts, never tokens, and never enter any token total.
   */
  counters: Record<string, Record<string, Record<string, number>>>
}

export function emptyOtel(): OtelState {
  return {
    active: false,
    lastEventAt: null,
    daily: {},
    costUsd: {},
    bySource: {},
    cumulative: {},
    counters: {},
  }
}
