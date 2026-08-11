import { identifyBlocks, lastActivity } from '../core/blocks.js'
import { activeBlock, burnRate } from '../core/burn.js'
import { estimateCeiling, percentOfCeiling } from '../core/ceiling.js'
import { type State, grandTotal } from '../core/types.js'

/** The live five-hour block, or null when nothing is running. */
export interface BlockView {
  tokens: number
  costUsd: number
  remainingMs: number
  tokensPerMinute: number | null
  /** Share of the observed ceiling, 0-100+, or null when there is nothing worth comparing against. */
  percentOfCeiling: number | null
  /** What that percentage is a share of, so the one-line form can say which. */
  ceilingBasis: 'limited' | 'observed' | null
}

/**
 * Blocks needed before "the largest one so far" means anything.
 *
 * With a young record the largest completed block can be a few minutes of work, against which a
 * normal session reads as 1269% and looks like an emergency. A limit that was actually hit needs no
 * such threshold: one is evidence, where one small block is not.
 */
const MIN_OBSERVED_SAMPLES = 5

/**
 * The live block, its rate, and how it compares to what this user usually gets through.
 *
 * This is the one number that answers "am I about to run out", which is why it sits on the
 * overview rather than behind a tab.
 */
export function blockView(state: State): BlockView | null {
  const now = new Date()
  const blocks = identifyBlocks(state, { now })
  const block = activeBlock(blocks)
  if (block === null) return null
  const rate = burnRate(block, lastActivity(state))
  const ceiling = estimateCeiling(blocks, state.limits)
  const used = grandTotal(block.totals)
  return {
    tokens: used,
    costUsd: block.costUsd,
    remainingMs: Math.max(0, block.endsAt.getTime() - now.getTime()),
    tokensPerMinute: rate?.tokensPerMinute ?? null,
    // Suppressed rather than shown with a caveat: this line has room for a number, not a sentence,
    // and a percentage of an unrepresentative baseline is worse than no percentage at all. The full
    // report spells the basis out in words.
    percentOfCeiling:
      ceiling !== null && (ceiling.basis === 'limited' || ceiling.samples >= MIN_OBSERVED_SAMPLES)
        ? percentOfCeiling(used, ceiling)
        : null,
    ceilingBasis: ceiling?.basis ?? null,
  }
}
