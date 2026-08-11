import { estimateCost } from './pricing.js'
import { type State, type Totals, addTotals, emptyTotals } from './types.js'

/**
 * Claude Code meters usage in rolling five-hour windows, so a block is the unit a user is actually
 * limited by. Overridable because the window is a product decision, not a law.
 */
export const BLOCK_HOURS = 5

/** Below this much elapsed time a burn rate is one message extrapolated over five hours. */
export const MIN_MINUTES_FOR_PROJECTION = 10

export const MINUTE = 60_000
const HOUR = 60 * MINUTE

export interface Block {
  /** Local hour key the block starts at, `YYYY-MM-DDTHH`. */
  startHour: string
  startsAt: Date
  endsAt: Date
  isActive: boolean
  /** A stretch of no usage at least one block long, kept so a report shows the shape of a day. */
  isGap: boolean
  byModel: Record<string, Totals>
  totals: Totals
  costUsd: number
}

export interface BurnRate {
  tokensPerMinute: number
  /**
   * Input plus output only.
   *
   * Cache reads outnumber output by two orders of magnitude in normal use, so a rate that includes
   * them measures the size of the context, not how hard the session is working.
   */
  tokensPerMinuteExcludingCache: number
  costPerHour: number
}

export interface Projection {
  totalTokens: number
  costUsd: number
  remainingMinutes: number
}

/** `YYYY-MM-DDTHH` to a local Date at the top of that hour. */
export function hourToDate(hour: string): Date {
  const year = Number(hour.slice(0, 4))
  const month = Number(hour.slice(5, 7))
  const day = Number(hour.slice(8, 10))
  const hours = Number(hour.slice(11, 13))
  return new Date(year, month - 1, day, hours, 0, 0, 0)
}

/**
 * When usage was last seen.
 *
 * `lastActivityAt` has second precision but is not restorable from the ledger, which stores only
 * additive deltas. After a rebuild it is null, so the newest hour bucket stands in. That start-of-
 * hour fallback is deliberately conservative: it can only make an active block look finished, never
 * make a finished one look live.
 */
export function lastActivity(state: State): Date | null {
  if (state.lastActivityAt !== null) {
    const parsed = new Date(state.lastActivityAt)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const hours = Object.keys(state.hourly).sort()
  const newest = hours[hours.length - 1]
  return newest === undefined ? null : hourToDate(newest)
}

function blockCost(byModel: Record<string, Totals>, day: string): number {
  let sum = 0
  for (const [model, totals] of Object.entries(byModel)) sum += estimateCost(model, totals, day)
  return sum
}

function finish(
  startHour: string,
  byModel: Record<string, Totals>,
  blockHours: number,
  now: Date,
  activity: Date | null,
): Block {
  const startsAt = hourToDate(startHour)
  const endsAt = new Date(startsAt.getTime() + blockHours * HOUR)
  const totals = emptyTotals()
  for (const model of Object.values(byModel)) addTotals(totals, model)
  return {
    startHour,
    startsAt,
    endsAt,
    // Active means the window is still open and something happened inside it. Both are required:
    // an open window with no recent activity is just a window.
    isActive:
      now < endsAt &&
      now >= startsAt &&
      activity !== null &&
      activity >= startsAt &&
      now.getTime() - activity.getTime() < blockHours * HOUR,
    isGap: false,
    byModel,
    totals,
    costUsd: blockCost(byModel, startHour.slice(0, 10)),
  }
}

function gapBlock(from: Date, to: Date): Block {
  return {
    startHour: '',
    startsAt: from,
    endsAt: to,
    isActive: false,
    isGap: true,
    byModel: {},
    totals: emptyTotals(),
    costUsd: 0,
  }
}

/**
 * Group hourly usage into five-hour blocks, oldest first.
 *
 * A block opens at the top of the hour of its first usage and closes when the window expires or
 * when the silence since the last usage reaches a full window, whichever comes first. That is the
 * same rule ccusage applies to individual message timestamps; applied to hour buckets it agrees
 * except within the opening hour, which is why the active block reads its own elapsed time from
 * `lastActivityAt` instead.
 */
export function identifyBlocks(
  state: State,
  options: { now?: Date; blockHours?: number } = {},
): Block[] {
  const now = options.now ?? new Date()
  const blockHours = options.blockHours ?? BLOCK_HOURS
  const activity = lastActivity(state)
  const hours = Object.keys(state.hourly).sort()

  const blocks: Block[] = []
  let startHour: string | null = null
  let previousHour: string | null = null
  let byModel: Record<string, Totals> = {}

  for (const hour of hours) {
    const at = hourToDate(hour)
    if (startHour !== null && previousHour !== null) {
      const sinceStart = at.getTime() - hourToDate(startHour).getTime()
      const sinceLast = at.getTime() - hourToDate(previousHour).getTime()
      if (sinceStart >= blockHours * HOUR || sinceLast >= blockHours * HOUR) {
        blocks.push(finish(startHour, byModel, blockHours, now, activity))
        if (sinceLast >= blockHours * HOUR) {
          blocks.push(gapBlock(new Date(hourToDate(previousHour).getTime() + HOUR), at))
        }
        startHour = null
        byModel = {}
      }
    }
    if (startHour === null) startHour = hour
    for (const [model, totals] of Object.entries(state.hourly[hour] ?? {})) {
      const target = byModel[model] ?? emptyTotals()
      addTotals(target, totals)
      byModel[model] = target
    }
    previousHour = hour
  }

  if (startHour !== null) blocks.push(finish(startHour, byModel, blockHours, now, activity))
  return blocks
}
