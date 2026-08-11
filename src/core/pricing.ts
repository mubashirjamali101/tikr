import { unqualify } from '../providers/registry.js'
import { type Rate, lookupRate } from './rates.js'
import type { Totals } from './types.js'

/**
 * How much a reported cost figure can be trusted.
 *
 * Every number this tool prints carries one of these, and the report names the weakest one present
 * rather than showing four estimates that look alike. `reported` is not produced here: it belongs
 * to Claude Code's own telemetry figure, which is a measurement rather than an estimate.
 */
export type CostBasis = 'exact' | 'family' | 'partial'

const BASIS_ORDER: CostBasis[] = ['exact', 'partial', 'family']

export interface ModelKey {
  provider: string
  /** Bare model id, with pricing suffixes removed. */
  model: string
  /** Billed at the fast-mode rate. */
  fast: boolean
  /** The request exceeded the model's long-context threshold. */
  long: boolean
}

/**
 * Split a bucket key into its pricing parts.
 *
 * Buckets encode price-affecting properties as suffixes in a fixed order, `<model>[-fast][-long]`,
 * so that a model billed two ways never merges into one row. The order is fixed so the same usage
 * can only ever produce one key.
 */
export function parseModelKey(key: string): ModelKey {
  const { provider, model } = unqualify(key)
  let name = model
  let long = false
  let fast = false
  if (name.endsWith('-long')) {
    long = true
    name = name.slice(0, -'-long'.length)
  }
  if (name.endsWith('-fast')) {
    fast = true
    name = name.slice(0, -'-fast'.length)
  }
  return { provider, model: name, fast, long }
}

/** Compose a bucket key from its parts. The inverse of `parseModelKey`. */
export function modelKey(provider: string, model: string, fast: boolean, long: boolean): string {
  return `${provider}/${model}${fast ? '-fast' : ''}${long ? '-long' : ''}`
}

function tier(rate: Rate, long: boolean): Omit<Rate, 'long'> {
  return long && rate.long !== undefined ? rate.long : rate
}

/**
 * Estimated USD for one bucket of usage.
 *
 * `day` selects a date-bounded rate when the caller knows which day the usage belongs to. Merged
 * buckets spanning several days have no single day, so they are priced at today's rate, which is
 * the same approximation the tool has always made.
 */
export function estimateCost(key: string, totals: Totals, day: string | null = null): number {
  const parts = parseModelKey(key)
  const lookup = lookupRate(parts.model, day)
  if (lookup.rate === null) return 0
  const rate = tier(lookup.rate, parts.long)
  const cost =
    (totals.input * rate.input +
      totals.output * rate.output +
      totals.cacheWrite5m * rate.cacheWrite5m +
      totals.cacheWrite1h * rate.cacheWrite1h +
      totals.cacheRead * rate.cacheRead) /
    1_000_000
  return parts.fast ? cost * lookup.fastMultiplier : cost
}

export function estimateCostByModel(
  byModel: Record<string, Totals>,
  day: string | null = null,
): number {
  let sum = 0
  for (const [model, totals] of Object.entries(byModel)) {
    sum += estimateCost(model, totals, day)
  }
  return sum
}

/** How the cost for one bucket key was arrived at. */
export function costBasis(key: string): CostBasis {
  const parts = parseModelKey(key)
  const lookup = lookupRate(parts.model)
  if (!lookup.exact || lookup.rate === null) return 'family'
  // An exact rate that cannot include a surcharge we know applies is not exact.
  if (parts.fast && !lookup.fastKnown) return 'partial'
  return 'exact'
}

/** The weakest basis across a set of bucket keys, which is what a report must disclose. */
export function weakestBasis(keys: Iterable<string>): CostBasis {
  let weakest: CostBasis = 'exact'
  for (const key of keys) {
    const basis = costBasis(key)
    if (BASIS_ORDER.indexOf(basis) > BASIS_ORDER.indexOf(weakest)) weakest = basis
  }
  return weakest
}

/** Models in this set whose cost is a family guess rather than a published rate. */
export function modelsPricedByFamily(keys: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const key of keys) {
    if (costBasis(key) === 'family') out.add(key)
  }
  return [...out].sort()
}

/** Models in this set counted at the standard rate because their fast surcharge is unpublished. */
export function modelsMissingFastRate(keys: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const key of keys) {
    const parts = parseModelKey(key)
    if (parts.fast && !lookupRate(parts.model).fastKnown) out.add(key)
  }
  return [...out].sort()
}
