import { bucketFor, counterFor } from './buckets.js'
import { recordLimitEvent } from './limits.js'
import type { State, Totals } from './types.js'
import { emptyOtel, emptyState } from './types.js'

/**
 * Flatten the aggregates to `key -> number` so two states can be diffed.
 *
 * Keys encode which bucket a number belongs to, which is also how ledger deltas are stored and
 * replayed. The format is `kind|bucket|model|field`, with `|` chosen because it cannot appear in a
 * date, a model id, or Claude Code's encoded project directory names.
 */
export type Snapshot = Record<string, number>

const FIELDS: Array<keyof Totals> = [
  'input',
  'output',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
  'messages',
]

function addBuckets(
  out: Snapshot,
  kind: string,
  buckets: Record<string, Record<string, Totals>>,
): void {
  for (const [bucket, byModel] of Object.entries(buckets)) {
    for (const [model, totals] of Object.entries(byModel)) {
      for (const field of FIELDS) {
        const value = totals[field]
        if (value !== 0) out[`${kind}|${bucket}|${model}|${field}`] = value
      }
    }
  }
}

export function snapshotOf(state: State): Snapshot {
  const out: Snapshot = {}
  addBuckets(out, 'd', state.daily)
  addBuckets(out, 'h', state.hourly)
  addBuckets(out, 'p', state.projects)
  addBuckets(out, 'o', state.otel.daily)
  // A limit event is a fact, not a quantity: the key carries it and the value is a presence flag.
  // That keeps the ledger's replay purely additive while still restoring the events themselves.
  for (const event of state.limits.events) {
    out[`l|${event.at}|${event.resetAt ?? '-'}`] = 1
  }
  for (const [metric, byDay] of Object.entries(state.otel.counters)) {
    for (const [day, bySignature] of Object.entries(byDay)) {
      for (const [signature, value] of Object.entries(bySignature)) {
        if (value !== 0) out[`x|${metric}|${day}|${signature}`] = value
      }
    }
  }
  for (const [model, usd] of Object.entries(state.otel.costUsd)) {
    if (usd !== 0) out[`c|${model}`] = usd
  }
  for (const [source, tokens] of Object.entries(state.otel.bySource)) {
    if (tokens !== 0) out[`s|${source}`] = tokens
  }
  return out
}

/** Increments from `before` to `after`. Only non-zero changes are kept. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Snapshot {
  const deltas: Snapshot = {}
  for (const [key, value] of Object.entries(after)) {
    const change = value - (before[key] ?? 0)
    if (change !== 0) deltas[key] = change
  }
  return deltas
}

/** Apply one flattened key back onto a state. Unknown keys are ignored rather than throwing. */
export function applyKey(state: State, key: string, value: number): void {
  const parts = key.split('|')
  const kind = parts[0]

  if (kind === 'c' && parts.length === 2) {
    state.otel.costUsd[parts[1]!] = (state.otel.costUsd[parts[1]!] ?? 0) + value
    return
  }
  if (kind === 's' && parts.length === 2) {
    state.otel.bySource[parts[1]!] = (state.otel.bySource[parts[1]!] ?? 0) + value
    return
  }
  if (kind === 'l' && parts.length === 3) {
    // A limit key is a presence flag, so only a positive delta means "this happened". The negative
    // case appears when an old event falls off the cap, and replaying it would resurrect the event.
    if (value <= 0) return
    const resetAt = parts[2] === '-' ? null : parts[2]!
    recordLimitEvent(state.limits, { at: parts[1]!, resetAt })
    return
  }
  if (kind === 'x' && parts.length === 4) {
    const [, metric, day, signature] = parts as [string, string, string, string]
    const bySignature = counterFor(state.otel.counters, metric, day)
    bySignature[signature] = (bySignature[signature] ?? 0) + value
    return
  }
  if (parts.length !== 4) return

  const [, bucket, rawModel, field] = parts as [string, string, string, keyof Totals]
  if (!FIELDS.includes(field)) return
  // Keys written before multi-provider support carry a bare model id, and those are all Claude
  // Code. Qualifying them on replay keeps existing ledgers readable and consistent with new keys.
  const model = rawModel.includes('/') ? rawModel : `claude-code/${rawModel}`

  const target =
    kind === 'd'
      ? state.daily
      : kind === 'h'
        ? state.hourly
        : kind === 'p'
          ? state.projects
          : kind === 'o'
            ? state.otel.daily
            : null
  if (target === null) return
  bucketFor(target, bucket, model)[field] += value
}

/**
 * Rebuild the aggregates by replaying ledger deltas.
 *
 * This is what makes `state.json` a cache rather than the record: if it is lost or damaged, the
 * numbers come back from the encrypted, hash-chained ledger instead of from transcripts that
 * Claude Code may already have deleted.
 */
export function rebuildFrom(
  payloads: Array<{ deltas: Snapshot; files?: Record<string, { offset: number; size: number }> }>,
): State {
  const state = emptyState()
  state.otel = emptyOtel()

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload.deltas)) {
      applyKey(state, key, value)
      if (key.startsWith('o|') || key.startsWith('c|') || key.startsWith('s|')) {
        state.otel.active = true
      }
    }
    for (const [path, position] of Object.entries(payload.files ?? {})) {
      state.files[path] = { offset: position.offset, size: position.size, series: {} }
    }
  }
  return state
}
