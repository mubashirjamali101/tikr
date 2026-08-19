/**
 * Grok's token truth is the OTLP log event `grok_code.api_request`.
 *
 * Session files under ~/.grok have no per-turn input/output counts. The external OTEL stream does:
 * each API request carries input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, a
 * model id, and a timestamp. That is the same shape tikr already folds for other tools, so Grok
 * usage lands in the main ledger as `grok/<model>` rather than in the Claude-only telemetry pane.
 *
 * Metrics `grok_code.token.usage` count the same tokens without a per-request timestamp. They are
 * ignored for totals so enabling both exporters cannot double-count.
 */
import { localDay, localHour } from '../core/parse.js'
import { emptyTotals } from '../core/types.js'
import type { UsageObservation } from '../providers/types.js'
import {
  decodeFields,
  decodeKeyValues,
  encodeFixed64Field,
  encodeKeyValue,
  encodeLenField,
  encodeStringField,
  fixed64Value,
  repeated,
  stringValue,
} from './protobuf.js'

export const GROK_API_REQUEST = 'grok_code.api_request'

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' || typeof value === 'bigint') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

function jsonAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { key?: unknown; value?: unknown }
    if (typeof entry.key !== 'string') continue
    const value = entry.value
    if (typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    const scalar = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue
    if (scalar !== undefined && scalar !== null) out[entry.key] = String(scalar)
  }
  return out
}

function isoFromNanos(value: unknown): string {
  if (typeof value === 'bigint') {
    const ms = Number(value / 1_000_000n)
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e15 ? value / 1e6 : value > 1e12 ? value / 1e6 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) return isoFromNanos(BigInt(value))
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

function observationFromAttrs(
  attrs: Record<string, string>,
  eventName: string | null,
  at: string,
): UsageObservation | null {
  const name = eventName ?? attrs['event.name'] ?? ''
  if (name !== GROK_API_REQUEST) return null

  const input = num(attrs.input_tokens)
  const output = num(attrs.output_tokens)
  // Reasoning is generated tokens. tikr has no separate reasoning bucket; Codex already folds
  // reasoning_output into output. Same here, so Grok reasoning is priced as output.
  const reasoning = num(attrs.reasoning_tokens)
  const cacheRead = num(attrs.cache_read_tokens)
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0) return null

  const model = attrs.model && attrs.model.length > 0 ? attrs.model : 'unknown'
  const day = localDay(at)
  const hour = localHour(at)
  if (day === null || hour === null) return null

  const series =
    attrs['event.sequence'] ??
    attrs['prompt.id'] ??
    `${attrs['session.id'] ?? 'grok'}:${at}:${model}:${input}:${output}`

  const totals = emptyTotals()
  totals.input = input
  totals.output = output + reasoning
  totals.cacheRead = cacheRead

  return {
    series,
    model,
    day,
    hour,
    at,
    totals,
    countMode: 'per-growth',
  }
}

/** OTLP/JSON ExportLogsServiceRequest. */
export function parseOtlpLogs(payload: unknown): UsageObservation[] {
  const out: UsageObservation[] = []
  if (typeof payload !== 'object' || payload === null) return out
  for (const resource of arrayOf((payload as Record<string, unknown>).resourceLogs)) {
    for (const scope of arrayOf((resource as Record<string, unknown>)?.scopeLogs)) {
      for (const raw of arrayOf((scope as Record<string, unknown>)?.logRecords)) {
        if (typeof raw !== 'object' || raw === null) continue
        const record = raw as Record<string, unknown>
        const attrs = jsonAttributes(record.attributes)
        const eventName =
          typeof record.eventName === 'string'
            ? record.eventName
            : typeof record.event_name === 'string'
              ? record.event_name
              : null
        const at = isoFromNanos(record.timeUnixNano ?? record.time_unix_nano)
        const observation = observationFromAttrs(attrs, eventName, at)
        if (observation !== null) out.push(observation)
      }
    }
  }
  return out
}

/** OTLP/protobuf ExportLogsServiceRequest. */
export function parseOtlpLogsProtobuf(buf: Buffer): UsageObservation[] {
  const out: UsageObservation[] = []
  try {
    const root = decodeFields(buf)
    for (const resource of repeated(root, 1)) {
      const resourceFields = decodeFields(resource.bytes)
      for (const scope of repeated(resourceFields, 2)) {
        const scopeFields = decodeFields(scope.bytes)
        for (const log of repeated(scopeFields, 2)) {
          const rec = decodeFields(log.bytes)
          const nanos = fixed64Value(rec, 1)
          const at = isoFromNanos(nanos ?? 0n)
          const eventName = stringValue(rec, 12)
          const attrs = decodeKeyValues(rec, 6)
          const observation = observationFromAttrs(attrs, eventName, at)
          if (observation !== null) out.push(observation)
        }
      }
    }
  } catch {
    return []
  }
  return out
}

/** Build a real-shaped ExportLogsServiceRequest protobuf for tests and fixtures. */
export function encodeGrokApiRequestProtobuf(attrs: {
  model: string
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  at?: Date
  sequence?: string
}): Buffer {
  const at = attrs.at ?? new Date('2026-08-20T12:00:00.000Z')
  const nanos = BigInt(at.getTime()) * 1_000_000n
  const kv = [
    encodeLenField(6, encodeKeyValue('event.name', GROK_API_REQUEST)),
    encodeLenField(6, encodeKeyValue('model', attrs.model)),
    encodeLenField(6, encodeKeyValue('input_tokens', attrs.input)),
    encodeLenField(6, encodeKeyValue('output_tokens', attrs.output)),
    encodeLenField(6, encodeKeyValue('reasoning_tokens', attrs.reasoning ?? 0)),
    encodeLenField(6, encodeKeyValue('cache_read_tokens', attrs.cacheRead ?? 0)),
    encodeLenField(6, encodeKeyValue('event.sequence', attrs.sequence ?? '1')),
    encodeLenField(6, encodeKeyValue('prompt.id', attrs.sequence ?? 'prompt-1')),
  ]
  const record = Buffer.concat([
    encodeFixed64Field(1, nanos),
    ...kv,
    encodeStringField(12, GROK_API_REQUEST),
  ])
  const scopeLogs = encodeLenField(2, encodeLenField(2, record))
  const resourceLogs = encodeLenField(1, scopeLogs)
  return resourceLogs
}

/** OTLP/JSON envelope matching the protobuf fixture. */
export function grokApiRequestJson(attrs: {
  model: string
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  at?: Date
  sequence?: string
}): unknown {
  const at = attrs.at ?? new Date('2026-08-20T12:00:00.000Z')
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(BigInt(at.getTime()) * 1_000_000n),
                eventName: GROK_API_REQUEST,
                attributes: [
                  { key: 'event.name', value: { stringValue: GROK_API_REQUEST } },
                  { key: 'model', value: { stringValue: attrs.model } },
                  { key: 'input_tokens', value: { intValue: String(attrs.input) } },
                  { key: 'output_tokens', value: { intValue: String(attrs.output) } },
                  {
                    key: 'reasoning_tokens',
                    value: { intValue: String(attrs.reasoning ?? 0) },
                  },
                  {
                    key: 'cache_read_tokens',
                    value: { intValue: String(attrs.cacheRead ?? 0) },
                  },
                  { key: 'event.sequence', value: { stringValue: attrs.sequence ?? '1' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}
