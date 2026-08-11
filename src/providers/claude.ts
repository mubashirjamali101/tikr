import { type Dirent, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseLimitEvent } from '../core/limits.js'
import { parseLine } from '../core/parse.js'
import { transcriptsRoot } from '../core/paths.js'
import { longContextThreshold } from '../core/rates.js'
import type { UsageRecord } from '../core/types.js'
import type { Provider, Signal, UsageObservation, UsageSource } from './types.js'

/** Guard against a symlink loop or a pathological tree; real layouts are 1-3 levels deep. */
const MAX_DEPTH = 6

function walk(dir: string, project: string, depth: number, out: UsageSource[]): void {
  if (depth > MAX_DEPTH) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, project, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push({ path, project })
  }
}

/**
 * Claude Code.
 *
 * The walk is recursive rather than a flat two-level listing: subagent transcripts live in
 * subdirectories (`<project>/<session>/agent-<id>.jsonl`), and skipping them silently drops all
 * subagent usage. Whatever the depth, a transcript is attributed to its top-level project
 * directory.
 */
function discover(): UsageSource[] {
  const root = transcriptsRoot()
  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const files: UsageSource[] = []
  for (const project of projects) {
    walk(join(root, project), project, 1, files)
  }
  return files
}

/**
 * Bucket key for a message, encoding the two things that change its price.
 *
 * Fast mode is billed at a multiple of the standard rate, and a request whose context exceeds the
 * model's published long-context threshold is billed at a second tier. Both become suffixes so the
 * differently-priced usage never merges into one bucket, and neither is invented: the long suffix
 * is only applied to a model that actually publishes a tier.
 */
function bucketModel(record: UsageRecord): string {
  const threshold = longContextThreshold(record.model)
  const long = threshold !== null && record.contextTokens > threshold
  return `${record.model}${record.fast ? '-fast' : ''}${long ? '-long' : ''}`
}

/**
 * One API message is written as several JSONL entries, one per content block, each carrying an
 * identical copy of `usage` - and a streamed message's copies grow as output accumulates. So the
 * message id is the series, and only the increase is counted. See docs/LESSONS.md.
 *
 * The request id joins the series key because a message id alone cannot tell a repeated content
 * block from a genuine retry of the same message: the first must be folded away, the second must be
 * counted. Entries predating `requestId` degrade to the bare message id, which is the old behavior.
 */
function parse(line: string): UsageObservation | null {
  const record = parseLine(line)
  if (record === null) return null
  return {
    series: `${record.messageId}:${record.requestId ?? ''}`,
    model: bucketModel(record),
    day: record.day,
    hour: record.hour,
    at: record.at,
    totals: {
      input: record.input,
      output: record.output,
      cacheWrite5m: record.cacheWrite5m,
      cacheWrite1h: record.cacheWrite1h,
      cacheRead: record.cacheRead,
      messages: 1,
    },
    countMode: 'cumulative',
  }
}

/**
 * Facts a line carries that are not usage.
 *
 * A refused request records an error entry naming the usage limit and the epoch it resets at. It is
 * gated on `isApiErrorMessage` first, so a transcript that merely quotes the marker - a
 * conversation about limits, or a tool result containing this file - is not read as having hit one.
 */
function parseSignal(line: string): Signal | null {
  if (!line.includes('"isApiErrorMessage":true')) return null
  let at: string | null = null
  try {
    const record = JSON.parse(line) as Record<string, unknown>
    at = typeof record.timestamp === 'string' ? record.timestamp : null
  } catch {
    return null
  }
  if (at === null) return null
  const event = parseLimitEvent(line, at)
  return event === null ? null : { kind: 'limit', event }
}

export const claudeProvider: Provider = {
  id: 'claude-code',
  name: 'Claude Code',
  root: transcriptsRoot,
  installed: () => existsSync(transcriptsRoot()),
  discover,
  parse,
  parseSignal,
  // Duplicate entries for a message id are always strictly consecutive (measured max gap: 1), so
  // remembering only the most recent series is sufficient and keeps state O(1) per file.
  retention: 'last-only',
}
