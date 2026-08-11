import { type Block, type BurnRate, lastActivity } from '../core/blocks.js'
import { activeBlock, burnRate, project } from '../core/burn.js'
import {
  type Ceiling,
  describeCeiling,
  estimateCeiling,
  nextReset,
  percentOfCeiling,
} from '../core/ceiling.js'
import type { State } from '../core/types.js'
import { grandTotal, nonCacheTotal } from '../core/types.js'
import { type Column, clock, count, duration, table, tokens, usd } from './format.js'
import { indent } from './render.js'

const COLUMNS: Column[] = [
  { header: 'Block', align: 'left' },
  { header: 'Span', align: 'left' },
  { header: 'Tokens', align: 'right' },
  { header: 'In+out', align: 'right' },
  { header: 'Msgs', align: 'right' },
  { header: 'Est. cost', align: 'right' },
]

function spanOf(block: Block, now: Date): string {
  if (block.isGap) return `${duration(block.endsAt.getTime() - block.startsAt.getTime())} idle`
  if (!block.isActive) return `${clock(block.startsAt)} - ${clock(block.endsAt)}`
  return `${duration(now.getTime() - block.startsAt.getTime())} in, ${duration(
    block.endsAt.getTime() - now.getTime(),
  )} left`
}

/** Five-hour blocks, newest first, which is the order a user reads them in. */
export function renderBlocks(blocks: Block[], now: Date = new Date()): string {
  if (blocks.length === 0) return 'By block\n  no usage recorded'
  const rows = [...blocks]
    .reverse()
    .map((block) => [
      block.isGap ? 'gap' : `${block.startHour.slice(0, 10)} ${clock(block.startsAt)}`,
      spanOf(block, now),
      block.isGap ? '-' : tokens(grandTotal(block.totals)),
      block.isGap ? '-' : tokens(nonCacheTotal(block.totals)),
      block.isGap ? '-' : count(block.totals.messages),
      block.isGap ? '-' : usd(block.costUsd),
    ])
  return `By block (${blocks.filter((block) => !block.isGap).length} blocks)\n${indent(
    table(COLUMNS, rows),
  )}`
}

function burnLine(rate: BurnRate): string {
  return `  Burn rate:     ${tokens(rate.tokensPerMinute)}/min  (${tokens(
    rate.tokensPerMinuteExcludingCache,
  )}/min excluding cache)  ${usd(rate.costPerHour)}/hour`
}

function ceilingLine(ceiling: Ceiling, block: Block): string {
  const percent = percentOfCeiling(grandTotal(block.totals), ceiling) ?? 0
  const state = percent >= 100 ? 'past' : percent >= 80 ? 'near' : 'within'
  return `  Against your usual: ${percent}% of ${tokens(ceiling.tokens)}, ${state} it (${describeCeiling(
    ceiling,
  )})`
}

/**
 * The active block, its rate, and where it lands.
 *
 * Returns an empty string when nothing is live, so a caller can print it unconditionally without
 * producing a section that says "nothing here".
 */
export function renderActiveBlock(state: State, blocks: Block[], now: Date = new Date()): string {
  const block = activeBlock(blocks)
  if (block === null) return ''

  const activity = lastActivity(state)
  const rate = burnRate(block, activity)
  const projection = project(block, rate, now)
  const lines = [
    'Current block',
    `  Started ${clock(block.startsAt)}, ${duration(
      block.endsAt.getTime() - now.getTime(),
    )} left of ${duration(block.endsAt.getTime() - block.startsAt.getTime())}`,
    `  Used so far:   ${tokens(grandTotal(block.totals))}  ${usd(block.costUsd)}`,
    `  Input+output:  ${tokens(nonCacheTotal(block.totals))}  (the rest is cache)`,
  ]
  if (rate !== null) lines.push(burnLine(rate))
  if (projection !== null) {
    lines.push(
      `  On this pace:  ${tokens(projection.totalTokens)}  ${usd(
        projection.costUsd,
      )} by ${clock(block.endsAt)}`,
    )
  }

  const ceiling = estimateCeiling(blocks, state.limits)
  if (ceiling !== null) lines.push(ceilingLine(ceiling, block))

  const reset = nextReset(state.limits, now)
  if (reset !== null) {
    // A bare clock time reads as "today". Say the date when it is not.
    const sameDay = reset.toDateString() === now.toDateString()
    const when = sameDay ? clock(reset) : `${reset.toDateString().slice(4)} ${clock(reset)}`
    lines.push(`  Limit resets:  ${when}`)
  }
  return lines.join('\n')
}
