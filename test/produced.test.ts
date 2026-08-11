import { describe, expect, it } from 'vitest'
import { emptyOtel } from '../src/core/types.js'
import { parseOtlpMetrics } from '../src/otlp/parse.js'
import { applySamples } from '../src/otlp/receiver.js'
import { renderProduced } from '../src/report/produced.js'

/** Envelope shape captured from a real Claude Code 2.1.126 OTLP/JSON export. */
function envelope(metrics: unknown[]): unknown {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeMetrics: [{ metrics }],
      },
    ],
  }
}

describe('outcome counters', () => {
  function counterMetric(name: string, value: string, temporality = 1, attrs: object[] = []) {
    return {
      name,
      sum: {
        aggregationTemporality: temporality,
        dataPoints: [{ asInt: value, attributes: attrs }],
      },
    }
  }

  it('accumulates counts without touching any token total', () => {
    const otel = emptyOtel()
    const before = JSON.stringify(otel.daily)
    applySamples(
      otel,
      parseOtlpMetrics(envelope([counterMetric('claude_code.commit.count', '3')])),
      new Date('2026-08-11T10:00:00Z'),
    )
    const day = Object.keys(otel.counters['claude_code.commit.count'] ?? {})[0]!
    expect(otel.counters['claude_code.commit.count']?.[day]?.all).toBe(3)
    expect(JSON.stringify(otel.daily)).toBe(before)
    expect(otel.bySource).toEqual({})
  })

  it('(bug) adds a cumulative counter once, not once per export', () => {
    const otel = emptyOtel()
    const payload = envelope([counterMetric('claude_code.commit.count', '5', 2)])
    const now = new Date('2026-08-11T10:00:00Z')
    applySamples(otel, parseOtlpMetrics(payload), now)
    applySamples(otel, parseOtlpMetrics(payload), now)
    const day = Object.keys(otel.counters['claude_code.commit.count'] ?? {})[0]!
    expect(otel.counters['claude_code.commit.count']?.[day]?.all).toBe(5)
  })

  it('keeps one signature per attribute set, dropping attributes it does not track', () => {
    const otel = emptyOtel()
    const now = new Date('2026-08-11T10:00:00Z')
    applySamples(
      otel,
      parseOtlpMetrics(
        envelope([
          counterMetric('claude_code.lines_of_code.count', '10', 1, [
            { key: 'type', value: { stringValue: 'added' } },
          ]),
        ]),
      ),
      now,
    )
    applySamples(
      otel,
      parseOtlpMetrics(
        envelope([
          counterMetric('claude_code.lines_of_code.count', '5', 1, [
            { key: 'type', value: { stringValue: 'added' } },
            { key: 'user.id', value: { stringValue: 'someone' } },
          ]),
        ]),
      ),
      now,
    )
    const day = Object.keys(otel.counters['claude_code.lines_of_code.count'] ?? {})[0]!
    expect(otel.counters['claude_code.lines_of_code.count']?.[day]?.['type=added']).toBe(15)
  })

  it('renders only the metrics that arrived', () => {
    const otel = emptyOtel()
    otel.counters = {
      'claude_code.commit.count': { '2026-08-11': { all: 4 } },
      // The rate is computed from the day-bucketed cost, which is what shares a window with it.
      'claude_code.cost.usage': { '2026-08-11': { 'claude-opus-5': 40 } },
    }
    otel.costUsd = { 'claude-opus-5': 40 }
    const rendered = renderProduced(otel)
    expect(rendered).toContain('Commits')
    expect(rendered).toContain('$10.00 each')
    expect(rendered).not.toContain('Pull requests')
    expect(renderProduced(emptyOtel())).toBe('')
  })
})

describe('per-unit basis', () => {
  it('(bug) divides cost and counts taken over the same days', () => {
    // costUsd runs from whenever telemetry was switched on; a counter runs from whenever that
    // metric first arrived. Pairing them printed $220 per 100 lines against a real cost of $3.
    const otel = emptyOtel()
    otel.costUsd = { 'claude-opus-5': 400 }
    otel.counters = {
      'claude_code.cost.usage': { '2026-08-11': { 'claude-opus-5': 3 } },
      'claude_code.commit.count': { '2026-08-11': { all: 3 } },
    }
    expect(renderProduced(otel)).toContain('$1.00 each')
  })

  it('shows counts without a rate when no cost has been recorded alongside them', () => {
    const otel = emptyOtel()
    otel.counters = { 'claude_code.commit.count': { '2026-08-11': { all: 2 } } }
    const rendered = renderProduced(otel)
    expect(rendered).toContain('Commits')
    expect(rendered).not.toContain('each')
  })
})
