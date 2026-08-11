import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { localDay, localHour } from '../core/parse.js'
import { emptyTotals } from '../core/types.js'
import type { Provider, UsageObservation, UsageSource } from './types.js'

/**
 * OpenAI Codex CLI.
 *
 * Sessions are JSONL "rollout" files. Usage arrives as `event_msg` records whose payload type is
 * `token_count`, carrying a running `total_token_usage` for the session. Verified against Codex
 * 0.42-1.17 rollouts: that total is **cumulative and monotonic** within a file (99 records checked
 * on one session, never decreasing), and `input_tokens + output_tokens == total_tokens` exactly.
 *
 * The model is not on the usage record; it is announced by `turn_context` records earlier in the
 * file, so the reader tracks the most recent one.
 */
function codexHome(): string {
  const override = process.env.CODEX_HOME
  return override && override.length > 0 ? override : join(homedir(), '.codex')
}

function collect(dir: string, project: string, out: UsageSource[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    if (name.endsWith('.jsonl')) out.push({ path, project })
  }
}

/**
 * Codex records the working directory in `session_meta`, but that is one line inside the file, and
 * discovery must not read every file to group them. Sessions are therefore bucketed by date folder
 * or by "sessions" / "archived", which is coarse but honest.
 */
function discover(): UsageSource[] {
  const home = codexHome()
  const out: UsageSource[] = []

  const sessions = join(home, 'sessions')
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessions, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 5) stack.push({ dir: path, depth: depth + 1 })
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push({ path, project: 'codex' })
    }
  }

  collect(join(home, 'archived_sessions'), 'codex', out)
  // These two live at the root and are not session rollouts.
  return out.filter((source) => {
    const name = basename(source.path)
    return name !== 'history.jsonl' && name !== 'session_index.jsonl'
  })
}

/** The model announced most recently, per file being parsed. */
const currentModel = new Map<string, string>()

/** Test seam, and a guard against the map growing across long runs. */
export function resetCodexModelCache(): void {
  currentModel.clear()
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function parseCodexLine(line: string, fileKey: string): UsageObservation | null {
  if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return null

  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as Record<string, unknown>

  if (record.type === 'turn_context') {
    if (typeof body.model === 'string') currentModel.set(fileKey, body.model)
    return null
  }
  if (body.type !== 'token_count') return null

  const info = body.info
  if (typeof info !== 'object' || info === null) return null
  const total = (info as Record<string, unknown>).total_token_usage
  if (typeof total !== 'object' || total === null) return null
  const usage = total as Record<string, unknown>

  const day = typeof record.timestamp === 'string' ? localDay(record.timestamp) : null
  const hour = typeof record.timestamp === 'string' ? localHour(record.timestamp) : null
  if (day === null || hour === null || typeof record.timestamp !== 'string') return null

  // `cached_input_tokens` is the cached portion *of* `input_tokens`, so the uncached remainder is
  // the difference. Booking the cached part as a cache read prices it at the right rate instead of
  // charging full input for tokens that were served from cache.
  const input = num(usage.input_tokens)
  const cached = Math.min(num(usage.cached_input_tokens), input)

  return {
    // One running total per session file, so the file itself is the series.
    series: 'session',
    model: currentModel.get(fileKey) ?? 'unknown',
    day,
    hour,
    at: record.timestamp,
    totals: {
      ...emptyTotals(),
      input: input - cached,
      cacheRead: cached,
      // `reasoning_output_tokens` is part of `output_tokens`, not additional to it.
      output: num(usage.output_tokens),
      messages: 0,
    },
    // Codex reports no request count, so turns are inferred from the running total moving.
    countMode: 'per-growth',
  }
}

export const codexProvider: Provider = {
  id: 'codex',
  name: 'Codex',
  root: codexHome,
  installed: () => existsSync(codexHome()),
  discover,
  parse: parseCodexLine,
  retention: 'all',
}
