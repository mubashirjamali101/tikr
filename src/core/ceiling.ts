import type { Block } from './blocks.js'
import type { LimitState } from './limits.js'
import { grandTotal } from './types.js'

/**
 * How much this user gets through in a block before running out.
 *
 * Every other tracker answers this with a table of subscription limits. Those numbers are not
 * published by Anthropic, so such a table is folklore: one widely-copied version even ships with an
 * `unverified: true` flag on a row. This estimator uses only first-hand evidence instead.
 *
 * `limited` is the honest answer: the 90th percentile of blocks in which a usage limit was actually
 * hit. `observed` is the fallback when no limit has ever been recorded, and it is a very different
 * claim - the largest block seen so far says nothing about where the limit is, only where this user
 * has been. The report must never present the two identically.
 */
export type CeilingBasis = 'limited' | 'observed'

export interface Ceiling {
  tokens: number
  basis: CeilingBasis
  /** How many blocks the figure was computed from. One sample is an anecdote; say so. */
  samples: number
}

/** Below this, a percentile is being read off too few points to mean anything. */
const MIN_LIMITED_SAMPLES = 3

/** Linear-interpolated percentile. `values` need not be sorted. */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0]!
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

/** Whether a limit was hit inside this block's window. */
function wasLimited(block: Block, limits: LimitState): boolean {
  return limits.events.some((event) => {
    const at = new Date(event.at).getTime()
    return Number.isFinite(at) && at >= block.startsAt.getTime() && at < block.endsAt.getTime()
  })
}

/**
 * Estimate the ceiling from completed blocks.
 *
 * Active blocks are excluded because they are still filling: including one would drag the estimate
 * down toward whatever it has reached so far.
 */
export function estimateCeiling(blocks: Block[], limits: LimitState): Ceiling | null {
  const completed = blocks.filter(
    (block) => !block.isGap && !block.isActive && grandTotal(block.totals) > 0,
  )
  if (completed.length === 0) return null

  const limited = completed
    .filter((block) => wasLimited(block, limits))
    .map((block) => grandTotal(block.totals))
  if (limited.length >= MIN_LIMITED_SAMPLES) {
    return {
      tokens: Math.round(percentile(limited, 0.9)),
      basis: 'limited',
      samples: limited.length,
    }
  }

  const totals = completed.map((block) => grandTotal(block.totals))
  return {
    tokens: Math.round(Math.max(...totals)),
    basis: 'observed',
    samples: completed.length,
  }
}

/**
 * Share of the ceiling a block has used, as a whole percent, or null when there is nothing to
 * compare against. One definition, because the terminal report and the dashboard must not disagree
 * about the same number.
 */
export function percentOfCeiling(used: number, ceiling: Ceiling | null): number | null {
  if (ceiling === null || ceiling.tokens <= 0) return null
  return Math.round((used / ceiling.tokens) * 100)
}

/** Wording that states exactly what the figure is, so it is never read as an account limit. */
export function describeCeiling(ceiling: Ceiling): string {
  return ceiling.basis === 'limited'
    ? `90th percentile of ${ceiling.samples} blocks that hit the limit`
    : `largest of ${ceiling.samples} completed blocks, no limit ever recorded`
}

/** The next reset still in the future, if one was recorded. */
export function nextReset(limits: LimitState, now: Date = new Date()): Date | null {
  let soonest: Date | null = null
  for (const event of limits.events) {
    if (event.resetAt === null) continue
    const reset = new Date(event.resetAt)
    if (Number.isNaN(reset.getTime()) || reset <= now) continue
    if (soonest === null || reset < soonest) soonest = reset
  }
  return soonest
}
