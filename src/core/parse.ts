import type { UsageRecord } from './types.js'

/** Locally-generated messages Claude Code records with this model name were never billed. */
const SYNTHETIC_MODEL = '<synthetic>'

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Local calendar day for an ISO timestamp. Users reason about "today" in their own timezone. */
export function localDay(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Local hour bucket, `YYYY-MM-DDTHH`.
 *
 * Local rather than UTC so it agrees with the day buckets and with the clock the user reads. The
 * `T` separator keeps an hour key sortable as a string and impossible to confuse with a day key.
 */
export function localHour(iso: string): string | null {
  const day = localDay(iso)
  if (day === null) return null
  return `${day}T${String(new Date(iso).getHours()).padStart(2, '0')}`
}

/**
 * Fast mode is billed above the standard rate, so the two must never share a bucket.
 *
 * The field sits inside `message.usage`, next to the token counts, and not on the message itself.
 * Verified on this machine: 41,900 entries carry it, 41,882 `standard`, 17 `null`, 1 `fast`. Only
 * the exact literal counts, so a null or an unknown value is standard.
 */
function isFast(usage: Record<string, unknown>): boolean {
  return usage.speed === 'fast'
}

/**
 * Extract usage from one transcript line, or return null if the line carries none.
 *
 * Returning null is the normal case: transcripts contain user turns, attachments, hook records and
 * more. Only `assistant` entries carry `message.usage`.
 */
export function parseLine(line: string): UsageRecord | null {
  if (line.length === 0 || !line.includes('"assistant"')) return null

  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    // A partially-flushed final line is expected while a session is live; skip it and let the
    // ingest pass pick it up once the writer completes it.
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null

  const record = entry as Record<string, unknown>
  if (record.type !== 'assistant') return null

  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const msg = message as Record<string, unknown>

  const messageId = msg.id
  const model = msg.model
  if (typeof messageId !== 'string' || typeof model !== 'string') return null
  if (model === SYNTHETIC_MODEL) return null

  const usage = msg.usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>

  const timestamp = record.timestamp
  const day = typeof timestamp === 'string' ? localDay(timestamp) : null
  const hour = typeof timestamp === 'string' ? localHour(timestamp) : null
  if (day === null || hour === null || typeof timestamp !== 'string') return null

  const cacheWrites = splitCacheWrites(u)
  const input = num(u.input_tokens)
  const cacheRead = num(u.cache_read_input_tokens)

  return {
    messageId,
    // Present on all but the oldest entries. Part of the series key so that a genuine retry of the
    // same message id contributes its own tokens instead of being folded away as a duplicate.
    requestId: typeof record.requestId === 'string' ? record.requestId : null,
    model,
    fast: isFast(u),
    day,
    hour,
    at: timestamp,
    // What the model actually read, which is what a long-context tier is charged on. Cache reads
    // dominate this figure in normal Claude Code use, so leaving them out would never trigger.
    contextTokens: input + cacheRead + cacheWrites.cacheWrite5m + cacheWrites.cacheWrite1h,
    input,
    output: num(u.output_tokens),
    cacheRead,
    ...cacheWrites,
  }
}

/**
 * Cache writes are priced by TTL (5-minute writes cost 1.25x base input, 1-hour writes 2x), so the
 * two are tracked separately. Older entries predate the `cache_creation` breakdown; for those,
 * charge the whole amount at the cheaper 5-minute rate rather than guessing high.
 */
function splitCacheWrites(u: Record<string, unknown>): {
  cacheWrite5m: number
  cacheWrite1h: number
} {
  const breakdown = u.cache_creation
  if (typeof breakdown === 'object' && breakdown !== null) {
    const b = breakdown as Record<string, unknown>
    const fiveMinute = num(b.ephemeral_5m_input_tokens)
    const oneHour = num(b.ephemeral_1h_input_tokens)
    if (fiveMinute > 0 || oneHour > 0) {
      return { cacheWrite5m: fiveMinute, cacheWrite1h: oneHour }
    }
  }
  return { cacheWrite5m: num(u.cache_creation_input_tokens), cacheWrite1h: 0 }
}
