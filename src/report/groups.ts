import { loadConfig } from '../core/config.js'
import { type Unit, type WeekDay, periodKey, periodLabel } from '../core/periods.js'
import { type State, type Totals, addTotals, emptyTotals, grandTotal } from '../core/types.js'
import { normalizeKey, unqualify } from '../providers/registry.js'
import { usd } from './format.js'
import { prettyProject } from './project.js'
import { bucketCost, sumByModel } from './render.js'

export type Bucket = [string, Record<string, Totals>]

/** Merge several `model -> totals` maps into one, folding legacy bare keys into qualified ones. */
export function mergeByModel(maps: Array<Record<string, Totals>>): Record<string, Totals> {
  const merged: Record<string, Totals> = {}
  for (const map of maps) {
    for (const [rawModel, totals] of Object.entries(map)) {
      const model = normalizeKey(rawModel)
      const target = merged[model] ?? emptyTotals()
      addTotals(target, totals)
      merged[model] = target
    }
  }
  return merged
}

/**
 * Day keys within the report window, oldest first.
 *
 * A null bound is open: `from` of null means every recorded day, `to` of null means up to the
 * newest. Both are inclusive, because a user who types a date means that day to be in the report.
 */
export function daysWithin(state: State, from: string | null, to: string | null = null): string[] {
  return Object.keys(state.daily)
    .sort()
    .filter((day) => (from === null || day >= from) && (to === null || day <= to))
}

/**
 * The days to show in a report. An unpinned default window that happens to be empty (history
 * older than 30 days is the usual case) falls back to everything recorded, so a first run is not
 * a blank table.
 */
export function daysForReport(
  state: State,
  from: string | null,
  to: string | null,
  pinned: boolean,
): { days: string[]; widened: boolean } {
  const days = daysWithin(state, from, to)
  if (days.length > 0 || pinned || from === null) return { days, widened: false }
  const all = daysWithin(state, null, to)
  return { days: all, widened: all.length > 0 }
}

/** Roll the day buckets up into days, weeks or months. */
export function byPeriod(
  state: State,
  days: string[],
  unit: Unit,
  startOn: WeekDay = 'monday',
): Bucket[] {
  const buckets = new Map<string, Record<string, Totals>>()
  for (const day of days) {
    const key = periodKey(day, unit, startOn)
    if (key === null) continue
    const target = buckets.get(key) ?? {}
    for (const [model, totals] of Object.entries(state.daily[day] ?? {})) {
      const merged = target[normalizeKey(model)] ?? emptyTotals()
      addTotals(merged, totals)
      target[normalizeKey(model)] = merged
    }
    buckets.set(key, target)
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function labelFor(unit: Unit): (key: string) => string {
  return (key) => periodLabel(key, unit)
}

/** One bucket per tool, so "which tool is costing me" has a one-line answer. */
export function byProvider(byModel: Record<string, Totals>): Bucket[] {
  const buckets: Record<string, Record<string, Totals>> = {}
  for (const [model, totals] of Object.entries(byModel)) {
    const { provider } = unqualify(model)
    const group = buckets[provider] ?? {}
    group[model] = totals
    buckets[provider] = group
  }
  return Object.entries(buckets).sort(([, a], [, b]) => bucketCost(b) - bucketCost(a))
}

export function byProject(state: State): Bucket[] {
  return Object.entries(state.projects).sort(([, a], [, b]) => bucketCost(b) - bucketCost(a))
}

export function projectLabel(key: string): string {
  return prettyProject(key, loadConfig().projects)
}

export interface Callout {
  label: string
  detail: string
}

/**
 * The single heaviest day and project.
 *
 * A sorted table can answer this, but only after the reader scans it. One line each is the whole
 * point: the answer, not the material for the answer.
 */
export function callouts(state: State, days: string[]): Callout[] {
  const out: Callout[] = []
  let topDay: [string, number] | null = null
  for (const day of days) {
    const cost = bucketCost(state.daily[day] ?? {}, day)
    if (topDay === null || cost > topDay[1]) topDay = [day, cost]
  }
  if (topDay !== null && topDay[1] > 0) {
    out.push({ label: 'Heaviest day', detail: `${topDay[0]}  ${usd(topDay[1])}` })
  }

  const top = byProject(state)[0]
  if (top !== undefined && grandTotal(sumByModel(top[1])) > 0) {
    out.push({
      label: 'Heaviest project',
      detail: `${projectLabel(top[0])}  ${usd(bucketCost(top[1]))} all time`,
    })
  }
  return out
}
