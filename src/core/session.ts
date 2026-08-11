import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseLine } from './parse.js'
import { transcriptsRoot } from './paths.js'
import { type Totals, addTotals, emptyTotals } from './types.js'

/**
 * One conversation's usage, read directly from its transcript.
 *
 * The aggregates are keyed by day, hour, model and project, never by session, because a per-session
 * bucket would grow without bound for a figure nobody asks about historically. The statusline does
 * want it, though, so it reads the one file instead. Bounded by a single transcript and, crucially,
 * **read-only**: ingesting here would race the daemon for the ledger and the state file, and lock
 * contention inside the prompt path would surface as a hang while typing.
 */

/** Claude Code's encoding of a working directory into a project directory name. */
export function encodeProject(cwd: string): string {
  return cwd.replaceAll('/', '-').replaceAll('\\', '-')
}

/**
 * Locate a session transcript.
 *
 * The encoded project directory is tried first, which is one stat. Subagent transcripts live a
 * level deeper and a session can be resumed from a different directory, so a bounded search of the
 * project directories is the fallback rather than a walk of the whole tree.
 */
export function findSessionFile(sessionId: string, cwd: string | null): string | null {
  const root = transcriptsRoot()
  const name = `${sessionId}.jsonl`

  if (cwd !== null) {
    const direct = join(root, encodeProject(cwd), name)
    if (existsSync(direct)) return direct
  }

  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  for (const project of projects) {
    const candidate = join(root, project, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export interface SessionUsage {
  totals: Totals
  /** Bucket keys involved, so the caller can price the session per model. */
  byModel: Record<string, Totals>
}

/**
 * Fold one transcript.
 *
 * Same dedupe rule as the ingest path: a message id can appear once per content block, each copy
 * carrying the same usage and a streamed copy growing, so the maximum per field within a series is
 * what counts. Reading the whole file is acceptable here because it is one file and the caller is
 * asking about it specifically.
 */
export function readSession(path: string): SessionUsage {
  const usage: SessionUsage = { totals: emptyTotals(), byModel: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return usage
  }

  const seen = new Map<string, Totals>()
  const models = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const record = parseLine(line)
    if (record === null) continue
    const series = `${record.messageId}:${record.requestId ?? ''}`
    const model = `claude-code/${record.model}${record.fast ? '-fast' : ''}`
    const previous = seen.get(series) ?? emptyTotals()
    seen.set(series, {
      input: Math.max(previous.input, record.input),
      output: Math.max(previous.output, record.output),
      cacheWrite5m: Math.max(previous.cacheWrite5m, record.cacheWrite5m),
      cacheWrite1h: Math.max(previous.cacheWrite1h, record.cacheWrite1h),
      cacheRead: Math.max(previous.cacheRead, record.cacheRead),
      messages: 1,
    })
    models.set(series, model)
  }

  for (const [series, totals] of seen) {
    const model = models.get(series) ?? 'claude-code/unknown'
    const target = usage.byModel[model] ?? emptyTotals()
    addTotals(target, totals)
    usage.byModel[model] = target
    addTotals(usage.totals, totals)
  }
  return usage
}
