/**
 * The fold: how one parsed observation becomes an increment in the aggregates.
 *
 * Split out of `ingest.ts`, which owns file reading and offsets, so that the counting rule can be
 * read on its own. This is the file to read before changing any number the tool reports.
 */
import { qualify } from '../providers/registry.js'
import type { Provider, UsageObservation } from '../providers/types.js'
import { bucketFor } from './buckets.js'
import { type FileState, type SeriesState, type State, addTotals, emptyTotals } from './types.js'

/**
 * Fold one observation into the aggregates.
 *
 * Every provider reports running totals for some series, so the rule is uniform: take the maximum
 * seen per field and add only the increase. That is idempotent, so re-reading a line changes
 * nothing, and it self-corrects when a later snapshot is larger.
 */
export function apply(
  state: State,
  provider: Provider,
  project: string,
  file: FileState,
  observation: UsageObservation,
): boolean {
  const model = qualify(provider.id, observation.model)
  const previous: SeriesState | undefined =
    provider.retention === 'last-only'
      ? file.series[Object.keys(file.series)[0] ?? '']
      : file.series[observation.series]

  const matches = previous !== undefined && sameSeries(previous.id, observation.series)
  const counted = matches ? previous.counted : emptyTotals()

  const delta = emptyTotals()
  let grew = false
  for (const field of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const) {
    const increase = Math.max(0, observation.totals[field] - counted[field])
    delta[field] = increase
    if (increase > 0) grew = true
  }
  delta.messages =
    observation.countMode === 'cumulative'
      ? Math.max(0, observation.totals.messages - counted.messages)
      : grew
        ? 1
        : 0

  // Attribute each increment to the day and model it was observed under, not to whatever the
  // series started as. A Codex session is one series that can run for hours and switch models, so
  // pinning would pile a multi-day session onto its first day under its first model. The series
  // only exists to hold the baseline; it does not own the attribution.
  addTotals(bucketFor(state.daily, observation.day, model), delta)
  addTotals(bucketFor(state.hourly, observation.hour, model), delta)
  addTotals(bucketFor(state.projects, project, model), delta)
  // Newest observation wins, and only ever moves forward: a re-read of an older file must not drag
  // "last activity" backwards, which would make an active block look finished.
  if (state.lastActivityAt === null || observation.at > state.lastActivityAt) {
    state.lastActivityAt = observation.at
  }

  const merged = emptyTotals()
  for (const field of [
    'input',
    'output',
    'cacheWrite5m',
    'cacheWrite1h',
    'cacheRead',
    'messages',
  ] as const) {
    merged[field] = Math.max(counted[field], observation.totals[field])
  }
  if (observation.countMode === 'per-growth') merged.messages = counted.messages

  const next: SeriesState = {
    id: observation.series,
    day: observation.day,
    model,
    project,
    counted: merged,
  }
  if (provider.retention === 'last-only') file.series = { [observation.series]: next }
  else file.series[observation.series] = next

  return delta.messages > 0
}

/**
 * Whether a stored series id refers to the same series as an incoming one.
 *
 * Exact match is the normal case. The prefix case exists only for the upgrade to composite
 * `messageId:requestId` keys: state written before that carries a bare message id, and without this
 * the in-flight message of every live transcript would look like a new series and be counted twice.
 * Safe to delete once every install has scanned at least once after 2026-08-11.
 */
function sameSeries(stored: string, incoming: string): boolean {
  if (stored === incoming) return true
  return !stored.includes(':') && incoming.startsWith(`${stored}:`)
}
