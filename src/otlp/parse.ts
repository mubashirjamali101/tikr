/**
 * Minimal reader for OTLP/JSON metric exports.
 *
 * Claude Code speaks OTLP over HTTP with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, which means the
 * payload is plain JSON and needs no protobuf decoder - the whole receiver stays dependency-free.
 *
 * Tokens and cost are read into their own buckets. Every other `claude_code.*` metric - lines of
 * code, commits, pull requests, sessions, tool decisions - is read as a counter, which is what makes
 * "what did the spend produce" answerable. Anything outside that namespace is ignored.
 */

export const TOKEN_METRIC = 'claude_code.token.usage'
export const COST_METRIC = 'claude_code.cost.usage'
export const GROK_TOKEN_METRIC = 'grok_code.token.usage'

/**
 * Attributes kept on a counter sample.
 *
 * An unbounded attribute set would grow the key space without limit, so only the ones that make a
 * counter meaningful are kept and everything else is dropped. `type` splits lines of code into
 * added and removed; `tool_name` and `decision` split tool use into accepted and rejected.
 */
export const COUNTER_ATTRIBUTES = ['type', 'tool_name', 'decision', 'language']

export interface OtelSample {
  kind: 'tokens' | 'cost' | 'counter'
  /** Metric name, for counter samples. */
  metric: string | null
  /** Attribute signature, for counter samples: sorted `key=value`, joined. */
  signature: string | null
  model: string
  /** input | output | cacheRead | cacheCreation - only set for token samples. */
  tokenType: string | null
  /** main | subagent | auxiliary */
  source: string | null
  value: number
  /** DELTA payloads carry an increment; CUMULATIVE payloads carry a running total. */
  cumulative: boolean
  /** Identifies one time series, so cumulative totals can be differenced across exports. */
  seriesKey: string
}

function attributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { key?: unknown; value?: unknown }
    if (typeof entry.key !== 'string') continue
    const value = entry.value
    if (typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    // OTLP/JSON encodes int64 as a string, so read whichever variant is present as text.
    const scalar = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue
    if (scalar !== undefined && scalar !== null) out[entry.key] = String(scalar)
  }
  return out
}

/** Data point values arrive as `asInt` (a string, per OTLP/JSON) or `asDouble` (a number). */
function pointValue(point: Record<string, unknown>): number {
  const asInt = point.asInt
  if (typeof asInt === 'string') {
    const parsed = Number(asInt)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (typeof asInt === 'number') return asInt
  const asDouble = point.asDouble
  return typeof asDouble === 'number' && Number.isFinite(asDouble) ? asDouble : 0
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Claude uses cacheRead; Grok uses cache_read. Reasoning is folded into output at apply time. */
function normalizeTokenType(type: string | undefined): string | null {
  if (type === undefined || type === '') return null
  if (type === 'cache_read') return 'cacheRead'
  if (type === 'cache_creation' || type === 'cacheCreation') return 'cacheCreation'
  return type
}

/**
 * Extract token and cost samples from an OTLP export request body.
 *
 * Returns an empty array rather than throwing on anything unexpected: this parses input from a
 * network socket, and a malformed payload must never take the service down.
 */
export function parseOtlpMetrics(payload: unknown): OtelSample[] {
  const samples: OtelSample[] = []
  if (typeof payload !== 'object' || payload === null) return samples

  for (const resource of arrayOf((payload as Record<string, unknown>).resourceMetrics)) {
    for (const scope of arrayOf((resource as Record<string, unknown>)?.scopeMetrics)) {
      for (const metric of arrayOf((scope as Record<string, unknown>)?.metrics)) {
        collectMetric(metric, samples)
      }
    }
  }
  return samples
}

function collectMetric(metric: unknown, out: OtelSample[]): void {
  if (typeof metric !== 'object' || metric === null) return
  const entry = metric as Record<string, unknown>
  const name = entry.name
  const kind =
    name === TOKEN_METRIC
      ? 'tokens'
      : name === COST_METRIC
        ? 'cost'
        : name === GROK_TOKEN_METRIC
          ? null
          : typeof name === 'string' &&
              (name.startsWith('claude_code.') || name.startsWith('grok_code.'))
            ? 'counter'
            : null
  if (kind === null) return

  // Both metrics are counters, which OTLP represents as `sum`.
  const sum = entry.sum
  if (typeof sum !== 'object' || sum === null) return
  const sumEntry = sum as Record<string, unknown>
  // 1 = DELTA (increment since last export), 2 = CUMULATIVE (running total).
  const cumulative = sumEntry.aggregationTemporality === 2

  for (const raw of arrayOf(sumEntry.dataPoints)) {
    if (typeof raw !== 'object' || raw === null) continue
    const point = raw as Record<string, unknown>
    const attrs = attributes(point.attributes)
    const model = attrs.model ?? 'unknown'
    const tokenType = kind === 'tokens' ? normalizeTokenType(attrs.type) : null
    const source = attrs.query_source ?? null
    const metric = kind === 'counter' ? String(name) : null
    const signature =
      kind === 'counter'
        ? COUNTER_ATTRIBUTES.filter((key) => attrs[key] !== undefined)
            .map((key) => `${key}=${attrs[key]}`)
            .join(',')
        : null
    out.push({
      kind,
      metric,
      signature,
      model,
      tokenType,
      source,
      value: pointValue(point),
      cumulative,
      seriesKey: [
        kind,
        metric ?? '',
        signature ?? '',
        model,
        tokenType ?? '',
        source ?? '',
        attrs['session.id'] ?? '',
      ].join('|'),
    })
  }
}
