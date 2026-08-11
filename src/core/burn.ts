/**
 * What an active block is doing right now: how fast, and where it lands.
 *
 * Separate from `blocks.ts`, which decides where blocks begin and end. Grouping is a fact about
 * history; a rate is a claim about the present, and the two have different failure modes.
 */
import type { Block, BurnRate, Projection } from './blocks.js'
import { MINUTE, MIN_MINUTES_FOR_PROJECTION } from './blocks.js'
import { grandTotal } from './types.js'

export function activeBlock(blocks: Block[]): Block | null {
  return blocks.find((block) => block.isActive) ?? null
}

/** Consumption rate of an active block, or null when too little has happened to measure one. */
export function burnRate(block: Block, activity: Date | null): BurnRate | null {
  if (block.isGap || activity === null) return null
  const minutes = (activity.getTime() - block.startsAt.getTime()) / MINUTE
  if (minutes < MIN_MINUTES_FOR_PROJECTION) return null
  const working = block.totals.input + block.totals.output
  return {
    tokensPerMinute: grandTotal(block.totals) / minutes,
    tokensPerMinuteExcludingCache: working / minutes,
    costPerHour: (block.costUsd / minutes) * 60,
  }
}

/** Where an active block lands if it keeps going at its current rate. */
export function project(
  block: Block,
  rate: BurnRate | null,
  now: Date = new Date(),
): Projection | null {
  if (!block.isActive || rate === null) return null
  const remainingMinutes = Math.max(
    0,
    Math.round((block.endsAt.getTime() - now.getTime()) / MINUTE),
  )
  return {
    totalTokens: Math.round(grandTotal(block.totals) + rate.tokensPerMinute * remainingMinutes),
    costUsd: block.costUsd + (rate.costPerHour / 60) * remainingMinutes,
    remainingMinutes,
  }
}
