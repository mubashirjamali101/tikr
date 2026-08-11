import type { LimitEvent } from '../core/limits.js'
import type { Totals } from '../core/types.js'

/** One append-only file a provider reads usage from. */
export interface UsageSource {
  path: string
  /** Bucket label for the "by project" report. */
  project: string
}

/**
 * How an observation contributes to the message tally.
 *
 * `cumulative` means `totals.messages` is itself a running count and is differenced like any other
 * field. `per-growth` is for tools that report tokens but no request count: one is added each time
 * the running totals actually move, which for those tools is once per turn.
 */
export type CountMode = 'cumulative' | 'per-growth'

/**
 * One usage observation parsed from a line.
 *
 * Every provider reports **cumulative** figures for some series, and the fold adds only the
 * increase over what was already counted. That single rule covers all three shapes seen in the
 * wild:
 *   - Claude Code repeats a message's usage across content blocks, growing as it streams
 *     (series = message id).
 *   - Codex writes a running `total_token_usage` per session (series = the file).
 *   - Copilot writes a `modelMetrics` snapshot per event (series = model within the file).
 */
export interface UsageObservation {
  /** Identifies the running total this line reports. Unique within a file. */
  series: string
  /** Model id as the tool records it, without a provider prefix. */
  model: string
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** Local hour, `YYYY-MM-DDTHH`. The resolution the block model needs. */
  hour: string
  /** The observation's own timestamp, ISO. */
  at: string
  totals: Totals
  countMode: CountMode
}

/**
 * Something a line says that is not usage.
 *
 * Kept separate from `UsageObservation` because a signal carries no tokens and must never touch a
 * total. Today there is one kind; the shape is a union so a second does not force a signature
 * change on every provider.
 */
export type Signal = { kind: 'limit'; event: LimitEvent }

/**
 * How many series a file can accumulate.
 *
 * `last-only` is for providers that mint a new series per message: keeping every one would grow
 * without bound, and it is unnecessary because their repeats are consecutive. `all` is for
 * providers with a small fixed set (one per session or per model), where a series stays live for
 * the whole file and must be remembered.
 */
export type SeriesRetention = 'last-only' | 'all'

export interface Provider {
  /** Stable id, used as the namespace in `provider/model` and in reports. */
  id: string
  /** Human-readable name. */
  name: string
  /** Directory watched for changes, even if it does not exist yet. */
  root: () => string
  /** Whether this tool appears to be installed and to have written anything. */
  installed: () => boolean
  /** Every file worth reading right now. */
  discover: () => UsageSource[]
  /**
   * Parse one line, or null when it carries no usage.
   *
   * `fileKey` identifies the file being read, for providers that must carry state between lines
   * (Codex announces the model on a separate record from the usage).
   */
  parse: (line: string, fileKey: string) => UsageObservation | null
  /** Non-usage facts worth recording, such as hitting the subscription limit. */
  parseSignal?: (line: string) => Signal | null
  retention: SeriesRetention
}
