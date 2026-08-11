import { type Totals, emptyTotals } from './types.js'

/**
 * The nested `bucket -> model -> totals` shape every aggregate uses.
 *
 * One helper rather than one per module: the fold, the ledger replay and the telemetry receiver all
 * need to reach into the same shape, and three copies of "create the level if it is missing" is
 * three chances to create it in only two of them.
 */
export type Buckets = Record<string, Record<string, Totals>>

/** The totals for one (bucket, model) pair, creating the levels that are missing. */
export function bucketFor(buckets: Buckets, bucket: string, model: string): Totals {
  let byModel = buckets[bucket]
  if (byModel === undefined) {
    byModel = {}
    buckets[bucket] = byModel
  }
  let totals = byModel[model]
  if (totals === undefined) {
    totals = emptyTotals()
    byModel[model] = totals
  }
  return totals
}

/** The counter for one (metric, day, signature) triple, creating the levels that are missing. */
export function counterFor(
  counters: Record<string, Record<string, Record<string, number>>>,
  metric: string,
  day: string,
): Record<string, number> {
  let byDay = counters[metric]
  if (byDay === undefined) {
    byDay = {}
    counters[metric] = byDay
  }
  let bySignature = byDay[day]
  if (bySignature === undefined) {
    bySignature = {}
    byDay[day] = bySignature
  }
  return bySignature
}
