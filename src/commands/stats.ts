import { BLOCK_HOURS, identifyBlocks } from '../core/blocks.js'
import { commit } from '../core/commit.js'
import { loadConfig } from '../core/config.js'
import { type Unit, type WeekDay, lastPeriodsSince, today } from '../core/periods.js'
import { scanAll } from '../core/scan.js'
import { loadState } from '../core/state.js'
import type { State, Totals } from '../core/types.js'
import { renderActiveBlock, renderBlocks } from '../report/blocks.js'
import { toCsv } from '../report/csv.js'
import {
  type Bucket,
  byPeriod,
  byProject,
  byProvider,
  callouts,
  daysForReport,
  labelFor,
  mergeByModel,
  projectLabel,
} from '../report/groups.js'
import { renderHeatmap } from '../report/heatmap.js'
import { renderToolDecisions } from '../report/produced.js'
import { costNotes, renderBuckets, renderByModel, sumByModel } from '../report/render.js'
import { printJson, printTelemetry } from '../report/sections.js'
import { type Args, flagBool, flagInt, flagString } from '../util/args.js'

const DEFAULT_LAST = 30

/** `--by` values that group time, and the unit each counts in for `--last`. */
const PERIOD_UNITS: Record<string, Unit> = { day: 'day', week: 'week', month: 'month' }

function windowStart(args: Args, unit: Unit, startOn: WeekDay): string | null {
  const explicit = flagString(args, 'since')
  if (explicit !== null) return explicit
  // 0 means every recorded period, which is why the minimum is 0 rather than 1.
  const last = flagInt(args, 'last', flagInt(args, 'days', DEFAULT_LAST, 0), 0)
  return last === 0 ? null : lastPeriodsSince(unit, last, today(), startOn)
}

/**
 * Show recorded usage.
 *
 * Scans before reporting unless `--no-scan` is passed, so the numbers are current even when the
 * background service is not running. That makes the tool useful standalone and means a stale
 * report is never shown without the user having asked for one.
 */
export function runStats(args: Args): number {
  const config = loadConfig()

  const groupBy = flagString(args, 'by') ?? 'model'
  const unit = PERIOD_UNITS[groupBy] ?? 'day'
  const startOn: WeekDay = flagString(args, 'week-start') === 'sunday' ? 'sunday' : 'monday'

  const { state } = loadState()
  if (!flagBool(args, 'no-scan')) {
    commit(state, 'transcript', (draft) => {
      scanAll(draft)
    })
  }

  const from = windowStart(args, unit, startOn)
  const pinned =
    args.flags.has('last') ||
    args.flags.has('days') ||
    args.flags.has('since') ||
    args.flags.has('until')
  const { days, widened } = daysForReport(state, from, flagString(args, 'until'), pinned)
  const totalsByModel = mergeByModel(days.map((day) => state.daily[day] ?? {}))

  if (flagBool(args, 'json')) return printJson(state, days, totalsByModel)
  if (flagBool(args, 'csv')) {
    console.log(toCsv(bucketsFor(state, days, groupBy, unit, startOn, totalsByModel)))
    return 0
  }

  // An empty window and an empty record read identically unless they are told apart, and the first
  // one is common: a tool used for a fortnight and then left alone falls out of the default window.
  const recorded = Object.keys(state.daily).length
  const range =
    days.length > 0
      ? `${days[0]} to ${days[days.length - 1]} (${days.length} day${days.length === 1 ? '' : 's'}${widened ? ', all recorded' : ''})`
      : recorded === 0
        ? 'no usage recorded yet'
        : `nothing in this window (${recorded} day${recorded === 1 ? '' : 's'} recorded, --last 0 shows all)`
  console.log(`Usage - ${range}\n`)
  console.log(renderSection(args, state, days, groupBy, unit, startOn, totalsByModel))

  if (config.problem !== null) console.log(`\n${config.problem}`)
  printBlocks(args, state, groupBy)
  if (flagBool(args, 'verbose')) {
    const decisions = renderToolDecisions(state.otel)
    if (decisions !== '') console.log(`\n${decisions}`)
  }
  printCallouts(state, days)
  printTelemetry(state)
  printFooter(totalsByModel, recorded)
  return 0
}

function bucketsFor(
  state: State,
  days: string[],
  groupBy: string,
  unit: Unit,
  startOn: WeekDay,
  byModel: Record<string, Totals>,
): Bucket[] {
  if (groupBy === 'project') return byProject(state)
  if (groupBy === 'provider') return byProvider(byModel)
  if (groupBy in PERIOD_UNITS) return byPeriod(state, days, unit, startOn)
  return [['all', byModel]]
}

/** Five hours is Claude Code's window, not a law, so it is overridable. */
function blocksOf(args: Args, state: State) {
  return identifyBlocks(state, { blockHours: flagInt(args, 'block-hours', BLOCK_HOURS) })
}

function renderSection(
  args: Args,
  state: State,
  days: string[],
  groupBy: string,
  unit: Unit,
  startOn: WeekDay,
  byModel: Record<string, Totals>,
): string {
  if (groupBy === 'hour') return renderHeatmap(state, days)
  if (groupBy === 'block') return renderBlocks(blocksOf(args, state))
  if (groupBy === 'project')
    return renderBuckets(byProject(state), 'By project (all time)', projectLabel)
  if (groupBy === 'provider') return renderBuckets(byProvider(byModel), 'By tool')
  if (groupBy in PERIOD_UNITS) {
    const buckets = byPeriod(state, days, unit, startOn).reverse()
    const title = unit === 'day' ? 'By day' : unit === 'week' ? 'By week' : 'By month'
    return renderBuckets(buckets, title, labelFor(unit))
  }
  return renderByModel(byModel, 'By model')
}

/** The live block is the answer to "am I about to run out", so it is shown unless it is the view. */
function printBlocks(args: Args, state: State, groupBy: string): void {
  if (groupBy === 'block') return
  const section = renderActiveBlock(state, blocksOf(args, state))
  if (section !== '') console.log(`\n${section}`)
}

function printCallouts(state: State, days: string[]): void {
  const lines = callouts(state, days)
  if (lines.length === 0) return
  console.log('')
  for (const line of lines) console.log(`${line.label}: ${line.detail}`)
}

function printFooter(byModel: Record<string, Totals>, recorded: number): void {
  if (sumByModel(byModel).messages === 0) {
    console.log(
      recorded === 0
        ? '\nNo usage recorded yet. Run `tikr start` to begin tracking.'
        : '\nNo usage in this window. Widen it with `--last 0`, `--last 90`, or `--since <date>`.',
    )
    return
  }
  console.log('')
  for (const note of costNotes(Object.keys(byModel))) console.log(note)
}
