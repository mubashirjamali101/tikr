import type { OtelState } from '../core/types.js'
import { COST_METRIC } from '../otlp/parse.js'
import { count, usd } from './format.js'
import { indent } from './render.js'

/**
 * What the spend produced.
 *
 * Claude Code's telemetry carries more than tokens: lines written, commits, pull requests, and how
 * often its edits were accepted. Cost per commit is a better question than cost, and this is the
 * only place the answer exists locally.
 *
 * Metric names are Claude Code's and are **unverified against a live export here**, so a metric
 * that never arrives is omitted rather than shown as zero. A zero that means "not measured" is a
 * lie, and this section is absent entirely when telemetry is off.
 */

interface Row {
  label: string
  metric: string
  /** Attribute signature to select, when the metric splits into several. */
  signature?: string
  /** Cost per this many units, when a per-unit figure is meaningful. */
  per?: number
}

const ROWS: Row[] = [
  {
    label: 'Lines added',
    metric: 'claude_code.lines_of_code.count',
    signature: 'type=added',
    per: 100,
  },
  { label: 'Lines removed', metric: 'claude_code.lines_of_code.count', signature: 'type=removed' },
  { label: 'Commits', metric: 'claude_code.commit.count', per: 1 },
  { label: 'Pull requests', metric: 'claude_code.pull_request.count', per: 1 },
  { label: 'Sessions', metric: 'claude_code.session.count' },
]

function totalFor(otel: OtelState, row: Row, days: Set<string> | null): number {
  const byDay = otel.counters[row.metric]
  if (byDay === undefined) return 0
  let sum = 0
  for (const [day, bySignature] of Object.entries(byDay)) {
    if (days !== null && !days.has(day)) continue
    for (const [signature, value] of Object.entries(bySignature)) {
      if (row.signature !== undefined && signature !== row.signature) continue
      sum += value
    }
  }
  return sum
}

/**
 * Cost over the same days as the counters, not the running total.
 *
 * `costUsd` accumulates from whenever telemetry was first switched on, while a counter accumulates
 * from whenever that metric first arrived. Dividing one by the other pairs two different windows,
 * which is how "$220 per 100 lines" gets printed next to a real cost of a few dollars.
 */
function reportedCost(otel: OtelState, days: Set<string> | null): number {
  const byDay = otel.counters[COST_METRIC]
  if (byDay === undefined) return 0
  let sum = 0
  for (const [day, byModel] of Object.entries(byDay)) {
    if (days !== null && !days.has(day)) continue
    for (const value of Object.values(byModel)) sum += value
  }
  return sum
}

/** Empty string when nothing was reported, so the caller can print it unconditionally. */
export function renderProduced(otel: OtelState, days: Set<string> | null = null): string {
  const cost = reportedCost(otel, days)
  const lines: string[] = []
  for (const row of ROWS) {
    const total = totalFor(otel, row, days)
    if (total === 0) continue
    // Per-unit figures use Claude Code's own cost, never our estimate, so one row never mixes a
    // measurement with a guess.
    const rate =
      row.per !== undefined && cost > 0 && total > 0
        ? `${usd((cost / total) * row.per)}${row.per === 1 ? ' each' : ` per ${row.per}`}`
        : ''
    lines.push(`  ${row.label.padEnd(16)}${count(total).padStart(10)}   ${rate}`.trimEnd())
  }
  if (lines.length === 0) return ''
  return `Produced (Claude Code telemetry)\n${lines.join('\n')}`
}

/** Tool edit decisions, accepted against rejected. Detail, so callers show it only on request. */
export function renderToolDecisions(otel: OtelState): string {
  const byDay = otel.counters['claude_code.code_edit_tool.decision']
  if (byDay === undefined) return ''
  const totals = new Map<string, number>()
  for (const bySignature of Object.values(byDay)) {
    for (const [signature, value] of Object.entries(bySignature)) {
      totals.set(signature, (totals.get(signature) ?? 0) + value)
    }
  }
  if (totals.size === 0) return ''
  const rows = [...totals.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([signature, value]) => `${signature}  ${count(value)}`)
  return `Tool decisions\n${indent(rows.join('\n'))}`
}
