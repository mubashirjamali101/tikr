import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localDay, localHour } from '../core/parse.js'
import { emptyTotals } from '../core/types.js'
import type { Provider, UsageObservation, UsageSource } from './types.js'

/**
 * GitHub Copilot CLI.
 *
 * Each session is a directory under `~/.copilot/session-state/<uuid>/` holding `events.jsonl`.
 * Events carry a `modelMetrics` object keyed by model:
 *
 *   "modelMetrics": { "gpt-5.4": {
 *      "requests": { "count": 16, "cost": 4 },
 *      "usage": { "inputTokens": 969621, "outputTokens": 16285,
 *                 "cacheReadTokens": 766976, "cacheWriteTokens": 0 } } }
 *
 * Those figures are a **running snapshot** rewritten on each event, so a series is one model within
 * one file and only the increase is counted. `requests.count` is itself cumulative, which gives an
 * exact request tally rather than an inferred one.
 */
function copilotHome(): string {
  const override = process.env.COPILOT_HOME
  return override && override.length > 0 ? override : join(homedir(), '.copilot')
}

function sessionRoot(): string {
  return join(copilotHome(), 'session-state')
}

function discover(): UsageSource[] {
  const out: UsageSource[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(sessionRoot(), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(sessionRoot(), entry.name, 'events.jsonl')
    if (existsSync(path)) out.push({ path, project: 'copilot' })
  }
  return out
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * A line can report several models at once, but an observation describes one series. The extras
 * are queued and drained by the reader before it advances to the next line.
 */
const pending = new Map<string, UsageObservation[]>()

export function drainPendingCopilot(fileKey: string): UsageObservation[] {
  const queued = pending.get(fileKey) ?? []
  pending.delete(fileKey)
  return queued
}

export function parseCopilotLine(line: string, fileKey: string): UsageObservation | null {
  if (!line.includes('modelMetrics')) return null

  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>

  const metrics = findModelMetrics(record)
  if (metrics === null) return null

  const day = typeof record.timestamp === 'string' ? localDay(record.timestamp) : null
  const hour = typeof record.timestamp === 'string' ? localHour(record.timestamp) : null
  if (day === null || hour === null || typeof record.timestamp !== 'string') return null

  const observations: UsageObservation[] = []
  for (const [model, raw] of Object.entries(metrics)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entryFor = raw as Record<string, unknown>
    const usage = entryFor.usage
    if (typeof usage !== 'object' || usage === null) continue
    const u = usage as Record<string, unknown>
    const requests = entryFor.requests
    const count =
      typeof requests === 'object' && requests !== null
        ? num((requests as Record<string, unknown>).count)
        : 0

    observations.push({
      series: `model:${model}`,
      model,
      day,
      hour,
      at: record.timestamp,
      totals: {
        ...emptyTotals(),
        input: num(u.inputTokens),
        output: num(u.outputTokens),
        cacheRead: num(u.cacheReadTokens),
        cacheWrite5m: num(u.cacheWriteTokens),
        messages: count,
      },
      countMode: 'cumulative',
    })
  }

  if (observations.length === 0) return null
  if (observations.length > 1) pending.set(fileKey, observations.slice(1))
  return observations[0]!
}

/** `modelMetrics` sits inside the event body, whose exact nesting varies by event type. */
function findModelMetrics(record: Record<string, unknown>): Record<string, unknown> | null {
  const direct = record.modelMetrics
  if (typeof direct === 'object' && direct !== null) return direct as Record<string, unknown>

  for (const value of Object.values(record)) {
    if (typeof value !== 'object' || value === null) continue
    const nested = (value as Record<string, unknown>).modelMetrics
    if (typeof nested === 'object' && nested !== null) return nested as Record<string, unknown>
  }
  return null
}

export const copilotProvider: Provider = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  root: sessionRoot,
  installed: () => existsSync(copilotHome()),
  discover,
  parse: parseCopilotLine,
  retention: 'all',
}
