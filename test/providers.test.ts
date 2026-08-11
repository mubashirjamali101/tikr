import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyResult, ingestFile } from '../src/core/ingest.js'
import { type State, emptyState } from '../src/core/types.js'
import { codexProvider, resetCodexModelCache } from '../src/providers/codex.js'
import { copilotProvider } from '../src/providers/copilot.js'
import { normalizeKey, qualify, unqualify } from '../src/providers/registry.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-prov-'))
  resetCodexModelCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, lines: unknown[]): string {
  const path = join(dir, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function ingest(state: State, provider: typeof codexProvider, path: string) {
  const result = emptyResult()
  ingestFile(state, provider, path, 'proj', result)
  return result
}

function total(state: State, model: string): number {
  let sum = 0
  for (const byModel of Object.values(state.daily)) {
    const t = byModel[model]
    if (t) sum += t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
  }
  return sum
}

/** Shape taken verbatim from a real Codex rollout file. */
function codexTurn(model: string) {
  return { timestamp: '2026-08-11T12:00:00.000Z', type: 'turn_context', payload: { model } }
}
function codexUsage(
  input: number,
  cached: number,
  output: number,
  at = '2026-08-11T12:00:00.000Z',
) {
  return {
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
    },
  }
}

describe('Codex', () => {
  it('reads a running total and books cached input as a cache read', () => {
    const path = write('a.jsonl', [codexTurn('gpt-5.5'), codexUsage(1000, 800, 50)])
    const state = emptyState()
    ingest(state, codexProvider, path)

    const totals = Object.values(state.daily)[0]?.['codex/gpt-5.5']
    // cached_input_tokens is the cached portion *of* input_tokens, not extra on top.
    expect(totals).toMatchObject({ input: 200, cacheRead: 800, output: 50 })
  })

  it('(bug) counts only the increase, because the total is cumulative', () => {
    // total_token_usage is a running total for the whole session. Adding each record verbatim
    // would multiply a long session's usage by its number of turns.
    const path = write('b.jsonl', [
      codexTurn('gpt-5.5'),
      codexUsage(100, 0, 10),
      codexUsage(300, 0, 40),
      codexUsage(600, 0, 90),
    ])
    const state = emptyState()
    ingest(state, codexProvider, path)

    expect(total(state, 'codex/gpt-5.5')).toBe(690)
  })

  it('counts one message per turn, since Codex reports no request count', () => {
    const path = write('c.jsonl', [
      codexTurn('gpt-5.5'),
      codexUsage(100, 0, 10),
      codexUsage(200, 0, 20),
    ])
    const state = emptyState()
    expect(ingest(state, codexProvider, path).messages).toBe(2)
  })

  it('attributes each increment to the model in force at the time', () => {
    const path = write('d.jsonl', [
      codexTurn('gpt-5.5'),
      codexUsage(100, 0, 0),
      codexTurn('gpt-5.4'),
      codexUsage(300, 0, 0),
    ])
    const state = emptyState()
    ingest(state, codexProvider, path)

    expect(total(state, 'codex/gpt-5.5')).toBe(100)
    expect(total(state, 'codex/gpt-5.4')).toBe(200)
  })

  it('(bug) attributes a session spanning days to each day it ran', () => {
    // The series is the whole session, which can run for hours. Pinning it to the first day would
    // pile a multi-day run onto day one.
    const path = write('e.jsonl', [
      codexTurn('gpt-5.5'),
      codexUsage(100, 0, 0, '2026-08-10T12:00:00.000Z'),
      codexUsage(500, 0, 0, '2026-08-11T12:00:00.000Z'),
    ])
    const state = emptyState()
    ingest(state, codexProvider, path)

    expect(state.daily['2026-08-10']?.['codex/gpt-5.5']?.input).toBe(100)
    expect(state.daily['2026-08-11']?.['codex/gpt-5.5']?.input).toBe(400)
  })

  it('carries the cumulative baseline across an incremental read', () => {
    const path = write('f.jsonl', [codexTurn('gpt-5.5'), codexUsage(100, 0, 0)])
    const state = emptyState()
    ingest(state, codexProvider, path)
    writeFileSync(
      path,
      `${[codexTurn('gpt-5.5'), codexUsage(100, 0, 0), codexUsage(450, 0, 0)]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    )
    ingest(state, codexProvider, path)

    expect(total(state, 'codex/gpt-5.5')).toBe(450)
  })
})

/** Shape taken verbatim from a real Copilot events.jsonl line. */
function copilotEvent(models: Record<string, [number, number, number, number, number]>) {
  const modelMetrics: Record<string, unknown> = {}
  for (const [model, [input, output, read, write_, count]] of Object.entries(models)) {
    modelMetrics[model] = {
      requests: { count, cost: 0 },
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: read,
        cacheWriteTokens: write_,
      },
    }
  }
  return { timestamp: '2026-08-11T12:00:00.000Z', state: { modelMetrics } }
}

describe('Copilot', () => {
  it('reads the per-model snapshot', () => {
    const path = write('g.jsonl', [copilotEvent({ 'gpt-5.4': [900, 16, 700, 5, 3] })])
    const state = emptyState()
    ingest(state, copilotProvider, path)

    expect(Object.values(state.daily)[0]?.['copilot/gpt-5.4']).toMatchObject({
      input: 900,
      output: 16,
      cacheRead: 700,
      cacheWrite5m: 5,
      messages: 3,
    })
  })

  it('(bug) counts only the increase, because each event restates the running totals', () => {
    const path = write('h.jsonl', [
      copilotEvent({ 'gpt-5.4': [100, 10, 0, 0, 1] }),
      copilotEvent({ 'gpt-5.4': [400, 40, 0, 0, 4] }),
    ])
    const state = emptyState()
    ingest(state, copilotProvider, path)

    expect(total(state, 'copilot/gpt-5.4')).toBe(440)
    expect(Object.values(state.daily)[0]?.['copilot/gpt-5.4']?.messages).toBe(4)
  })

  it('(bug) records every model on a line, not just the first', () => {
    // modelMetrics reports all models at once; taking only the first silently drops the rest.
    const path = write('i.jsonl', [
      copilotEvent({ 'gpt-5.4': [100, 0, 0, 0, 1], 'claude-sonnet-4.5': [200, 0, 0, 0, 1] }),
    ])
    const state = emptyState()
    ingest(state, copilotProvider, path)

    expect(total(state, 'copilot/gpt-5.4')).toBe(100)
    expect(total(state, 'copilot/claude-sonnet-4.5')).toBe(200)
  })
})

describe('model key namespacing', () => {
  it('round-trips a qualified key', () => {
    expect(unqualify(qualify('codex', 'gpt-5.5'))).toEqual({ provider: 'codex', model: 'gpt-5.5' })
  })

  it('(bug) treats a legacy bare key as Claude Code', () => {
    // Ledgers written before multi-provider support carry bare model ids; discarding them on
    // replay would lose the entire pre-existing history.
    expect(unqualify('claude-opus-5')).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-5',
    })
  })

  it('keeps a model id containing a slash intact after the first segment', () => {
    expect(unqualify('codex/vendor/model-1')).toEqual({
      provider: 'codex',
      model: 'vendor/model-1',
    })
  })
})

describe('legacy key normalisation', () => {
  it('(bug) merges a bare key with its qualified equivalent', () => {
    // State written before namespacing holds `claude-opus-5`; new state holds
    // `claude-code/claude-opus-5`. Left unmerged they render as two identical-looking rows.
    expect(normalizeKey('claude-opus-5')).toBe('claude-code/claude-opus-5')
    expect(normalizeKey('claude-code/claude-opus-5')).toBe('claude-code/claude-opus-5')
    expect(normalizeKey('codex/gpt-5.5')).toBe('codex/gpt-5.5')
  })
})
