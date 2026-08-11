import { identifyBlocks } from '../core/blocks.js'
import { estimateCostByModel } from '../core/pricing.js'
import type { State, Totals } from '../core/types.js'
import { since, tokens, usd } from './format.js'
import { renderProduced } from './produced.js'

/**
 * The two report sections that are their own shape: machine-readable output, and the telemetry
 * feed. Split out of the command so that `stats` stays orchestration and these stay formatting.
 */
export function printJson(state: State, days: string[], byModel: Record<string, Totals>): number {
  console.log(
    JSON.stringify(
      {
        days: days.length,
        from: days[0] ?? null,
        to: days[days.length - 1] ?? null,
        byModel,
        byDay: Object.fromEntries(days.map((day) => [day, state.daily[day] ?? {}])),
        byProject: state.projects,
        blocks: identifyBlocks(state).filter((block) => !block.isGap).length,
        limitEvents: state.limits.events,
        telemetry: state.otel.active ? state.otel : null,
        estimatedCostUsd: Number(estimateCostByModel(byModel).toFixed(4)),
      },
      null,
      2,
    ),
  )
  return 0
}

/**
 * Telemetry is reported as its own section, never folded into the totals above.
 *
 * Both sources describe the same tokens, so adding them would double every number. What telemetry
 * uniquely provides is Claude Code's own cost figure, the main/subagent split, and what the work
 * produced.
 */
export function printTelemetry(state: State): void {
  const otel = state.otel
  if (!otel.active) return

  const cost = Object.values(otel.costUsd).reduce((sum, value) => sum + value, 0)
  console.log(`\nTelemetry feed (last event ${since(otel.lastEventAt)})`)
  if (cost > 0) {
    console.log(`  Reported cost: ${usd(cost)}  (Claude Code's own figure, not an estimate)`)
  }
  const sources = Object.entries(otel.bySource).sort(([, a], [, b]) => b - a)
  if (sources.length > 0) {
    const parts = sources.map(([name, value]) => `${name} ${tokens(value)}`).join('   ')
    console.log(`  By source:     ${parts}`)
  }
  console.log('  Counts the same tokens as above from a second source, so it is shown separately.')

  const produced = renderProduced(otel)
  if (produced !== '') console.log(`\n${produced}`)
}
