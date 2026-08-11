import { estimateCost } from '../core/pricing.js'
import { type Totals, grandTotal, nonCacheTotal } from '../core/types.js'
import { sumByModel } from './render.js'

/**
 * CSV of the same rows the table shows.
 *
 * JSON serves a program; CSV serves the spreadsheet where an expense claim actually gets made.
 * Written to stdout like every other output, so redirection stays the user's choice and the tool
 * never creates a file outside its own directory.
 */

const HEADER = [
  'bucket',
  'model',
  'input',
  'output',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
  'total',
  'totalExcludingCache',
  'messages',
  'estimatedCostUsd',
]

/** Quote only when needed, and double any embedded quote. A project name can contain a comma. */
function cell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function line(bucket: string, model: string, totals: Totals, cost: number): string {
  return [
    bucket,
    model,
    totals.input,
    totals.output,
    totals.cacheWrite5m,
    totals.cacheWrite1h,
    totals.cacheRead,
    grandTotal(totals),
    nonCacheTotal(totals),
    totals.messages,
    cost.toFixed(4),
  ]
    .map(cell)
    .join(',')
}

/** One row per (bucket, model) pair, plus a per-bucket total row when a bucket has several. */
export function toCsv(buckets: Array<[string, Record<string, Totals>]>): string {
  const rows = [HEADER.join(',')]
  for (const [bucket, byModel] of buckets) {
    const models = Object.entries(byModel)
    for (const [model, totals] of models) {
      rows.push(line(bucket, model, totals, estimateCost(model, totals)))
    }
    if (models.length > 1) {
      let cost = 0
      for (const [model, totals] of models) cost += estimateCost(model, totals)
      rows.push(line(bucket, 'ALL', sumByModel(byModel), cost))
    }
  }
  return rows.join('\n')
}
