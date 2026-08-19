import { type Server, createServer } from 'node:http'
import { bucketFor, counterFor } from '../core/buckets.js'
import { localDay } from '../core/parse.js'
import type { OtelState, Totals } from '../core/types.js'
import type { UsageObservation } from '../providers/types.js'
import { parseOtlpLogs, parseOtlpLogsProtobuf } from './logs.js'
import { COST_METRIC, type OtelSample, parseOtlpMetrics } from './parse.js'
import {
  decodeFields,
  decodeKeyValues,
  repeated,
  sfixed64Value,
  stringValue,
  varintValue,
} from './protobuf.js'

export const DEFAULT_OTLP_PORT = 4318

/** Body cap. Real exports are a few KB; anything vastly larger is not a metrics payload. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const TOKEN_FIELD: Record<string, keyof Totals> = {
  input: 'input',
  output: 'output',
  reasoning: 'output',
  cacheRead: 'cacheRead',
  // Telemetry does not split cache creation by TTL, so it lands in the cheaper 5-minute bucket.
  // Measured against Claude Code's own cost metric, these writes are in fact 1-hour ones, so an
  // estimate over telemetry buckets understates by that margin - see docs/LESSONS.md. It stays
  // conservative on purpose: the telemetry section reports Claude Code's figure, not an estimate,
  // and the transcript path has the real TTL split.
  cacheCreation: 'cacheWrite5m',
}

/**
 * Fold one export's samples into the telemetry section of state.
 *
 * DELTA samples are increments and simply accumulate. CUMULATIVE samples are running totals, so
 * only the increase over the previously seen value for that series is added - otherwise a restart
 * or a re-export would count the same tokens repeatedly.
 */
export function applySamples(otel: OtelState, samples: OtelSample[], now = new Date()): number {
  let applied = 0
  const day = localDay(now.toISOString()) ?? 'unknown'

  for (const sample of samples) {
    let value = sample.value
    if (sample.cumulative) {
      const previous = otel.cumulative[sample.seriesKey] ?? 0
      otel.cumulative[sample.seriesKey] = Math.max(previous, value)
      value = Math.max(0, value - previous)
    }
    if (value <= 0) continue

    if (sample.kind === 'counter') {
      // Counts, not tokens. Kept in their own section and never added to any token total: they
      // describe what the work produced, which only means something next to the cost, not inside it.
      const metric = sample.metric ?? 'unknown'
      const bySignature = counterFor(otel.counters, metric, day)
      const signature =
        sample.signature === null || sample.signature === '' ? 'all' : sample.signature
      bySignature[signature] = (bySignature[signature] ?? 0) + value
      applied += 1
      continue
    }

    if (sample.kind === 'cost') {
      otel.costUsd[sample.model] = (otel.costUsd[sample.model] ?? 0) + value
      // Also bucketed by day, so a per-unit figure ("cost per commit") can be computed over the
      // same window as the counter it is divided by. The running total above has no window, and
      // dividing it by a counter that started later produces a number that is confidently wrong.
      counterFor(otel.counters, COST_METRIC, day)[sample.model] =
        (counterFor(otel.counters, COST_METRIC, day)[sample.model] ?? 0) + value
      applied += 1
      continue
    }

    const field = sample.tokenType === null ? undefined : TOKEN_FIELD[sample.tokenType]
    if (field === undefined) continue

    bucketFor(otel.daily, day, sample.model)[field] += value

    if (sample.source !== null) {
      otel.bySource[sample.source] = (otel.bySource[sample.source] ?? 0) + value
    }
    applied += 1
  }

  if (applied > 0) {
    otel.active = true
    otel.lastEventAt = now.toISOString()
  }
  return applied
}

export interface ReceiverOptions {
  port?: number
  /** Called with the samples from each accepted export. */
  onSamples: (samples: OtelSample[]) => void
  /** Grok API-request log events, folded into the main ledger. */
  onGrok?: (observations: UsageObservation[]) => void
  onError?: (message: string) => void
}

/**
 * An OTLP/HTTP metrics endpoint for Claude Code to push usage to.
 *
 * Bound to 127.0.0.1 only. This listener accepts unauthenticated writes to the usage counters, so
 * it must never be reachable from another machine; loopback keeps it to processes already running
 * as this user.
 */
export function startOtlpReceiver(options: ReceiverOptions): Server {
  const port = options.port ?? DEFAULT_OTLP_PORT

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end('{}')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      // Always answer 200: an exporter that sees an error will retry the same payload, and a
      // payload we cannot read will not become readable on the second attempt.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      try {
        const body = Buffer.concat(chunks)
        if (body.length === 0) return
        dispatch(req.url ?? '/', req.headers['content-type'] ?? '', body, options)
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error))
      }
    })

    req.on('error', () => {})
  })

  server.on('error', (error) => {
    options.onError?.(error.message)
  })
  server.listen(port, '127.0.0.1')
  return server
}

function isProtobuf(contentType: string): boolean {
  return (
    contentType.includes('application/x-protobuf') ||
    contentType.includes('application/protobuf') ||
    contentType.includes('application/x-google-protobuf')
  )
}

function isLogs(url: string): boolean {
  return url.includes('/v1/logs')
}

function isMetrics(url: string): boolean {
  return url.includes('/v1/metrics') || url === '/' || url.length === 0
}

function dispatch(url: string, contentType: string, body: Buffer, options: ReceiverOptions): void {
  const proto = isProtobuf(contentType)
  if (isLogs(url)) {
    const observations = proto ? parseOtlpLogsProtobuf(body) : parseOtlpLogs(parseJson(body))
    if (observations.length > 0) options.onGrok?.(observations)
    return
  }
  if (!isMetrics(url) && proto) {
    // Some exporters POST protobuf to / without a signal path. Try logs first, then metrics.
    const observations = parseOtlpLogsProtobuf(body)
    if (observations.length > 0) {
      options.onGrok?.(observations)
      return
    }
  }
  const samples = parseOtlpMetrics(proto ? protobufMetricsToJson(body) : parseJson(body))
  if (samples.length > 0) options.onSamples(samples)
}

function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8'))
}

/**
 * Metrics protobuf is decoded only far enough to reuse the JSON collector.
 * Grok token metrics are dropped there on purpose (same tokens as the log events).
 */
function protobufMetricsToJson(buf: Buffer): unknown {
  const metrics: unknown[] = []
  for (const resource of repeated(decodeFields(buf), 1)) {
    const resourceFields = decodeFields(resource.bytes)
    for (const scope of repeated(resourceFields, 2)) {
      const scopeFields = decodeFields(scope.bytes)
      for (const metric of repeated(scopeFields, 2)) {
        const rec = decodeFields(metric.bytes)
        const name = stringValue(rec, 1)
        const sumField = rec.find((f) => f.n === 7 && f.wire === 2)
        if (name === null || sumField === undefined) continue
        const sum = decodeFields(sumField.bytes)
        const temporality = Number(varintValue(sum, 2) ?? 1n)
        const dataPoints = repeated(sum, 1).map((point) => {
          const p = decodeFields(point.bytes)
          const attrs = decodeKeyValues(p, 7)
          const asInt = sfixed64Value(p, 6)
          const dbl = p.find((f) => f.n === 4 && f.bytes.length === 8)
          return {
            asInt: asInt !== null ? String(asInt) : undefined,
            asDouble: dbl ? dbl.bytes.readDoubleLE(0) : undefined,
            attributes: Object.entries(attrs).map(([key, value]) => ({
              key,
              value: { stringValue: value },
            })),
          }
        })
        metrics.push({
          name,
          sum: { aggregationTemporality: temporality, dataPoints },
        })
      }
    }
  }
  return { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] }
}
