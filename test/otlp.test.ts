import { describe, expect, it } from 'vitest'
import { emptyOtel } from '../src/core/types.js'
import { COST_METRIC, TOKEN_METRIC, parseOtlpMetrics } from '../src/otlp/parse.js'
import { applySamples } from '../src/otlp/receiver.js'

/** Envelope shape captured from a real Claude Code 2.1.126 OTLP/JSON export. */
function envelope(metrics: unknown[]): unknown {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeMetrics: [{ scope: { name: 'com.anthropic.claude_code' }, metrics }],
      },
    ],
  }
}

function tokenMetric(
  points: Array<{ type: string; model: string; value: number; source?: string }>,
  temporality = 1,
): unknown {
  return {
    name: TOKEN_METRIC,
    unit: 'tokens',
    sum: {
      aggregationTemporality: temporality,
      isMonotonic: true,
      dataPoints: points.map((point) => ({
        // OTLP/JSON encodes int64 as a string, which is the trap here.
        asInt: String(point.value),
        attributes: [
          { key: 'type', value: { stringValue: point.type } },
          { key: 'model', value: { stringValue: point.model } },
          ...(point.source === undefined
            ? []
            : [{ key: 'query_source', value: { stringValue: point.source } }]),
          { key: 'session.id', value: { stringValue: 'sess-1' } },
        ],
      })),
    },
  }
}

describe('parseOtlpMetrics', () => {
  it('reads token samples out of a real-shaped envelope', () => {
    const samples = parseOtlpMetrics(
      envelope([tokenMetric([{ type: 'output', model: 'claude-opus-5', value: 281 }])]),
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      kind: 'tokens',
      model: 'claude-opus-5',
      tokenType: 'output',
      value: 281,
      cumulative: false,
    })
  })

  it('(bug) parses int64 values delivered as strings', () => {
    // asInt arrives as "281", not 281. Reading it as a number yields NaN and silently zeroes usage.
    const samples = parseOtlpMetrics(
      envelope([tokenMetric([{ type: 'input', model: 'claude-opus-5', value: 9007199254 }])]),
    )
    expect(samples[0]?.value).toBe(9007199254)
  })

  it('reads the cost metric as a double', () => {
    const samples = parseOtlpMetrics(
      envelope([
        {
          name: COST_METRIC,
          unit: 'USD',
          sum: {
            aggregationTemporality: 1,
            dataPoints: [
              {
                asDouble: 0.0432,
                attributes: [{ key: 'model', value: { stringValue: 'claude-opus-5' } }],
              },
            ],
          },
        },
      ]),
    )
    expect(samples[0]).toMatchObject({ kind: 'cost', value: 0.0432 })
  })

  it('marks cumulative series so they can be differenced', () => {
    const samples = parseOtlpMetrics(
      envelope([tokenMetric([{ type: 'output', model: 'm', value: 5 }], 2)]),
    )
    expect(samples[0]?.cumulative).toBe(true)
  })

  it('ignores metrics outside the claude_code namespace', () => {
    const samples = parseOtlpMetrics(
      envelope([{ name: 'process.runtime.memory', sum: { dataPoints: [{ asInt: '1' }] } }]),
    )
    expect(samples).toEqual([])
  })

  it('reads every other claude_code metric as a counter', () => {
    const samples = parseOtlpMetrics(
      envelope([
        {
          name: 'claude_code.lines_of_code.count',
          sum: {
            dataPoints: [
              {
                asInt: '42',
                attributes: [
                  { key: 'type', value: { stringValue: 'added' } },
                  { key: 'session.id', value: { stringValue: 'ignored-attribute' } },
                ],
              },
            ],
          },
        },
      ]),
    )
    expect(samples[0]).toMatchObject({
      kind: 'counter',
      metric: 'claude_code.lines_of_code.count',
      signature: 'type=added',
      value: 42,
    })
  })

  it('returns nothing rather than throwing on malformed input', () => {
    // The payload arrives from a socket; a crash here would take the service down.
    expect(parseOtlpMetrics(null)).toEqual([])
    expect(parseOtlpMetrics({ resourceMetrics: 'nope' })).toEqual([])
    expect(
      parseOtlpMetrics({ resourceMetrics: [{ scopeMetrics: [{ metrics: [null] }] }] }),
    ).toEqual([])
  })
})

describe('applySamples', () => {
  it('accumulates delta samples into the right token fields', () => {
    const otel = emptyOtel()
    applySamples(
      otel,
      parseOtlpMetrics(
        envelope([
          tokenMetric([
            { type: 'input', model: 'claude-opus-5', value: 10 },
            { type: 'output', model: 'claude-opus-5', value: 20 },
            { type: 'cacheRead', model: 'claude-opus-5', value: 30 },
            { type: 'cacheCreation', model: 'claude-opus-5', value: 40 },
          ]),
        ]),
      ),
    )

    const totals = Object.values(otel.daily)[0]?.['claude-opus-5']
    expect(totals).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite5m: 40 })
    expect(otel.active).toBe(true)
  })

  it('sums repeated delta exports', () => {
    const otel = emptyOtel()
    const payload = envelope([tokenMetric([{ type: 'output', model: 'm', value: 5 }])])
    applySamples(otel, parseOtlpMetrics(payload))
    applySamples(otel, parseOtlpMetrics(payload))
    expect(Object.values(otel.daily)[0]?.m?.output).toBe(10)
  })

  it('(bug) adds only the increase for cumulative series', () => {
    // A cumulative counter reports a running total. Adding it verbatim on every export would count
    // the same tokens again and again.
    const otel = emptyOtel()
    applySamples(
      otel,
      parseOtlpMetrics(envelope([tokenMetric([{ type: 'output', model: 'm', value: 100 }], 2)])),
    )
    applySamples(
      otel,
      parseOtlpMetrics(envelope([tokenMetric([{ type: 'output', model: 'm', value: 175 }], 2)])),
    )

    expect(Object.values(otel.daily)[0]?.m?.output).toBe(175)
  })

  it('ignores a cumulative counter that resets backwards', () => {
    const otel = emptyOtel()
    applySamples(
      otel,
      parseOtlpMetrics(envelope([tokenMetric([{ type: 'output', model: 'm', value: 100 }], 2)])),
    )
    applySamples(
      otel,
      parseOtlpMetrics(envelope([tokenMetric([{ type: 'output', model: 'm', value: 10 }], 2)])),
    )
    expect(Object.values(otel.daily)[0]?.m?.output).toBe(100)
  })

  it('splits tokens by query source, which transcripts cannot distinguish', () => {
    const otel = emptyOtel()
    applySamples(
      otel,
      parseOtlpMetrics(
        envelope([
          tokenMetric([
            { type: 'output', model: 'm', value: 10, source: 'main' },
            { type: 'output', model: 'm', value: 4, source: 'subagent' },
          ]),
        ]),
      ),
    )
    expect(otel.bySource).toEqual({ main: 10, subagent: 4 })
  })

  it('accumulates the reported cost per model', () => {
    const otel = emptyOtel()
    const cost = {
      name: COST_METRIC,
      sum: {
        aggregationTemporality: 1,
        dataPoints: [
          { asDouble: 0.5, attributes: [{ key: 'model', value: { stringValue: 'm' } }] },
        ],
      },
    }
    applySamples(otel, parseOtlpMetrics(envelope([cost])))
    applySamples(otel, parseOtlpMetrics(envelope([cost])))
    expect(otel.costUsd.m).toBeCloseTo(1.0, 6)
  })

  it('stays inactive when an export carries nothing usable', () => {
    const otel = emptyOtel()
    applySamples(
      otel,
      parseOtlpMetrics(envelope([tokenMetric([{ type: 'weird', model: 'm', value: 5 }])])),
    )
    expect(otel.active).toBe(false)
    expect(otel.lastEventAt).toBeNull()
  })
})
