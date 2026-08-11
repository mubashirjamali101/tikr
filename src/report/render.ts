import { estimateCost, modelsMissingFastRate, modelsPricedByFamily } from '../core/pricing.js'
import { type Totals, addTotals, emptyTotals, grandTotal, nonCacheTotal } from '../core/types.js'
import { type Column, count, table, terminalWidth, tokens, usd } from './format.js'

/**
 * Columns in drop order.
 *
 * A narrow terminal wraps a wide table into unreadable rubble, so columns are dropped instead,
 * least important first. The label, the total and the cost are never dropped: they are the answer
 * to the question the table was printed for.
 */
const TOKEN_COLUMNS: Array<Column & { drop: number }> = [
  { header: '', align: 'left', drop: 0 },
  { header: 'Input', align: 'right', drop: 4 },
  { header: 'Output', align: 'right', drop: 5 },
  { header: 'Cache write', align: 'right', drop: 1 },
  { header: 'Cache read', align: 'right', drop: 2 },
  { header: 'In+out', align: 'right', drop: 0 },
  { header: 'Total', align: 'right', drop: 0 },
  { header: 'Msgs', align: 'right', drop: 3 },
  { header: 'Est. cost', align: 'right', drop: 0 },
]

/** Width below which the widest columns start being dropped, matching the field's convention. */
const COMPACT_WIDTH = 120

function visibleColumns(width: number): Array<Column & { drop: number }> {
  if (width >= COMPACT_WIDTH) return TOKEN_COLUMNS
  // Roughly nine characters per column of margin; each step removes the next-least-useful column.
  const steps = Math.min(5, Math.ceil((COMPACT_WIDTH - width) / 12))
  return TOKEN_COLUMNS.filter((column) => column.drop === 0 || column.drop > steps)
}

function tokenTable(rows: string[][], width = terminalWidth()): string {
  const columns = visibleColumns(width)
  const kept = columns.map((column) => TOKEN_COLUMNS.indexOf(column))
  return table(
    columns.map(({ header, align }) => ({ header, align })),
    rows.map((row) => kept.map((index) => row[index] ?? '')),
  )
}

function cells(label: string, totals: Totals, cost: number): string[] {
  return [
    label,
    tokens(totals.input),
    tokens(totals.output),
    tokens(totals.cacheWrite5m + totals.cacheWrite1h),
    tokens(totals.cacheRead),
    tokens(nonCacheTotal(totals)),
    tokens(grandTotal(totals)),
    count(totals.messages),
    usd(cost),
  ]
}

export function sumByModel(byModel: Record<string, Totals>): Totals {
  const total = emptyTotals()
  for (const totals of Object.values(byModel)) addTotals(total, totals)
  return total
}

/** Cost of a mixed-model bucket, priced per model then summed. */
export function bucketCost(byModel: Record<string, Totals>, day: string | null = null): number {
  let sum = 0
  for (const [model, totals] of Object.entries(byModel)) sum += estimateCost(model, totals, day)
  return sum
}

/** Per-model breakdown, heaviest first. */
export function renderByModel(byModel: Record<string, Totals>, title: string): string {
  const entries = Object.entries(byModel).sort(([, a], [, b]) => grandTotal(b) - grandTotal(a))
  if (entries.length === 0) return `${title}\n  no usage recorded`

  const rows = entries.map(([model, totals]) => cells(model, totals, estimateCost(model, totals)))
  rows.push(cells('TOTAL', sumByModel(byModel), bucketCost(byModel)))
  return `${title}\n${indent(tokenTable(rows))}`
}

/**
 * One row per bucket (day, week, month or project), in the order the caller supplies.
 *
 * A bucket keyed by a date is priced on that date, so a row inside a promotional pricing window
 * gets that window's rate. Project rows have no single date and are priced at today's.
 */
export function renderBuckets(
  buckets: Array<[string, Record<string, Totals>]>,
  title: string,
  label: (key: string) => string = (key) => key,
): string {
  if (buckets.length === 0) return `${title}\n  no usage recorded`
  const rows = buckets.map(([key, byModel]) =>
    cells(label(key), sumByModel(byModel), bucketCost(byModel, dayOf(key))),
  )
  return `${title}\n${indent(tokenTable(rows))}`
}

/** A bucket key that is itself a date, or null. Week and month keys are their first day. */
function dayOf(key: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/**
 * Lines disclosing how solid the cost figures are.
 *
 * Every estimate carries a basis, and the weakest one present is what the reader needs to know.
 * Saying nothing would present a family guess and a published rate as the same kind of number.
 */
export function costNotes(models: Iterable<string>): string[] {
  const keys = [...models]
  const notes = [
    'Cost is an estimate of equivalent Claude API spend at published list rates.',
    'It is not a bill: most Claude Code usage is billed by subscription, not by the token.',
  ]
  const family = modelsPricedByFamily(keys)
  if (family.length > 0) {
    notes.push(`Priced by model family (no exact published rate): ${family.join(', ')}`)
  }
  const fast = modelsMissingFastRate(keys)
  if (fast.length > 0) {
    notes.push(
      `Fast-mode usage counted at the standard rate, surcharge unpublished: ${fast.join(', ')}`,
    )
  }
  return notes
}
