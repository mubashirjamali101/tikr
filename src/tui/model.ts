import { loadConfig } from '../core/config.js'
import {
  type State,
  type Totals,
  addTotals,
  emptyTotals,
  grandTotal,
  withoutCache,
} from '../core/types.js'
import { PROVIDERS, normalizeKey, unqualify } from '../providers/registry.js'
import { prettyProject } from '../report/project.js'
import { bucketCost, sumByModel } from '../report/render.js'

export interface Row {
  key: string
  label: string
  /** Dominant tool by token count, used for colour and for the single-tool case. */
  provider: string
  /** Every tool that contributed, heaviest first. A project can be worked on by more than one. */
  providers: string[]
  totals: Totals
  cost: number
  /** Cost of the input and output alone, for the cache-free view. */
  nonCacheCost: number
  /** Daily token counts, oldest first, for the sparkline. */
  trend: number[]
}

import { type BlockView, blockView } from './block.js'

export interface Snapshot {
  from: string | null
  to: string | null
  days: string[]
  total: Totals
  totalCost: number
  byProvider: Row[]
  byModel: Row[]
  byProject: Row[]
  byDay: Row[]
  /** Tools that are installed but have contributed nothing yet. */
  idle: string[]
  block: BlockView | null
}

/**
 * Every tool that contributed to a bucket, heaviest first.
 *
 * A project is frequently worked on with more than one tool, so naming it after whichever model
 * happened to be enumerated first was arbitrary and could change between runs.
 */
/** A per-model map with the cache columns removed, priced as its own thing. */
function stripCache(byModel: Record<string, Totals>): Record<string, Totals> {
  const out: Record<string, Totals> = {}
  for (const [model, totals] of Object.entries(byModel)) out[model] = withoutCache(totals)
  return out
}

function providersOf(byModel: Record<string, Totals>): string[] {
  const weights = new Map<string, number>()
  for (const [model, totals] of Object.entries(byModel)) {
    const { provider } = unqualify(model)
    weights.set(provider, (weights.get(provider) ?? 0) + grandTotal(totals))
  }
  return [...weights.entries()].sort(([, a], [, b]) => b - a).map(([provider]) => provider)
}

function trendFor(
  days: string[],
  source: Record<string, Record<string, Totals>>,
  match: (model: string) => boolean,
): number[] {
  return days.map((day) => {
    let value = 0
    for (const [model, totals] of Object.entries(source[day] ?? {})) {
      if (match(model)) value += grandTotal(totals)
    }
    return value
  })
}

function group(
  days: string[],
  daily: Record<string, Record<string, Totals>>,
  keyOf: (model: string) => string,
  labelOf: (key: string) => string,
  providerOf: (key: string) => string,
): Row[] {
  const buckets: Record<string, Record<string, Totals>> = {}
  for (const day of days) {
    for (const [model, totals] of Object.entries(daily[day] ?? {})) {
      const key = keyOf(model)
      const bucket = buckets[key] ?? {}
      const target = bucket[model] ?? emptyTotals()
      addTotals(target, totals)
      bucket[model] = target
      buckets[key] = bucket
    }
  }

  return Object.entries(buckets)
    .map(([key, byModel]) => ({
      key,
      label: labelOf(key),
      provider: providerOf(key),
      providers: providersOf(byModel),
      totals: sumByModel(byModel),
      cost: bucketCost(byModel),
      nonCacheCost: bucketCost(stripCache(byModel)),
      trend: trendFor(days, daily, (model) => keyOf(model) === key),
    }))
    .sort((a, b) => grandTotal(b.totals) - grandTotal(a.totals))
}

/** Everything the views need, computed once per repaint from the cached state. */
export function snapshot(state: State, windowDays: number): Snapshot {
  const all = Object.keys(state.daily).sort()
  const days = windowDays <= 0 ? all : all.slice(-windowDays)

  const merged: Record<string, Totals> = {}
  for (const day of days) {
    for (const [model, totals] of Object.entries(state.daily[day] ?? {})) {
      const target = merged[model] ?? emptyTotals()
      addTotals(target, totals)
      merged[model] = target
    }
  }

  const byProvider = group(
    days,
    state.daily,
    (model) => unqualify(model).provider,
    (key) => PROVIDERS.find((provider) => provider.id === key)?.name ?? key,
    (key) => key,
  )

  const active = new Set(byProvider.map((entry) => entry.key))

  const byProject = Object.entries(state.projects).map(([key, byModel]) => {
    const providers = providersOf(byModel)
    return {
      key,
      label: prettyProject(key, loadConfig().projects),
      provider: providers[0] ?? '',
      providers,
      totals: sumByModel(byModel),
      cost: bucketCost(byModel),
      nonCacheCost: bucketCost(stripCache(byModel)),
      trend: [] as number[],
    }
  })

  const byDay: Row[] = days
    .slice()
    .reverse()
    .map((day) => {
      const byModel = state.daily[day] ?? {}
      return {
        key: day,
        label: day,
        provider: '',
        providers: providersOf(byModel),
        totals: sumByModel(byModel),
        cost: bucketCost(byModel),
        nonCacheCost: bucketCost(stripCache(byModel)),
        trend: [],
      }
    })

  return {
    block: blockView(state),
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    days,
    total: sumByModel(merged),
    totalCost: bucketCost(merged),
    byProvider,
    byModel: group(
      days,
      state.daily,
      normalizeKey,
      (key) => unqualify(key).model,
      (key) => unqualify(key).provider,
    ),
    byProject,
    byDay,
    idle: PROVIDERS.filter((provider) => provider.installed() && !active.has(provider.id)).map(
      (provider) => provider.name,
    ),
  }
}
