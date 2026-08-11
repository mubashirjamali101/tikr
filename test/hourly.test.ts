import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyResult, ingestFile } from '../src/core/ingest.js'
import { applyKey, diffSnapshots, snapshotOf } from '../src/core/snapshot.js'
import { type State, emptyState, grandTotal } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'counter-hourly-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function message(over: Record<string, unknown> = {}): object {
  return {
    type: 'assistant',
    timestamp: '2026-08-11T09:15:00.000Z',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
      ...over,
    },
    ...(over.top as object),
  }
}

function ingest(state: State, path: string): void {
  ingestFile(state, claudeProvider, path, 'project', emptyResult())
}

/** Hour keys are local, so the expected key is derived rather than hardcoded. */
function hourOf(iso: string): string {
  const date = new Date(iso)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}T${String(date.getHours()).padStart(2, '0')}`
}

describe('hourly buckets', () => {
  it('records usage at hour resolution alongside the day', () => {
    const state = emptyState()
    ingest(state, transcript([message()]))
    const hour = hourOf('2026-08-11T09:15:00.000Z')
    expect(state.hourly[hour]?.['claude-code/claude-opus-5']?.output).toBe(100)
    expect(Object.keys(state.daily)).toHaveLength(1)
  })

  it('separates messages in different hours', () => {
    const state = emptyState()
    ingest(
      state,
      transcript([
        message(),
        {
          ...message({ id: 'msg_2' }),
          timestamp: '2026-08-11T11:15:00.000Z',
        },
      ]),
    )
    expect(Object.keys(state.hourly)).toHaveLength(2)
  })

  it('advances last activity but never rewinds it', () => {
    const state = emptyState()
    state.lastActivityAt = '2027-01-01T00:00:00.000Z'
    ingest(state, transcript([message()]))
    expect(state.lastActivityAt).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('fast mode and long context bucketing', () => {
  it('keeps fast usage in its own bucket', () => {
    const state = emptyState()
    ingest(
      state,
      transcript([
        message({
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 5,
            speed: 'fast',
          },
        }),
      ]),
    )
    expect(
      Object.keys(state.daily['2026-08-11'] ?? state.daily[Object.keys(state.daily)[0]!]!),
    ).toEqual(['claude-code/claude-opus-5-fast'])
  })

  it('marks a request as long only for a model that publishes a tier', () => {
    const state = emptyState()
    const big = {
      input_tokens: 300_000,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    }
    ingest(state, transcript([message({ model: 'claude-sonnet-4-5', usage: big })]))
    ingest(state, transcript([message({ model: 'claude-opus-5', usage: big })]))
    const models = Object.keys(state.daily[Object.keys(state.daily)[0]!]!)
    expect(models).toContain('claude-code/claude-sonnet-4-5-long')
    expect(models).toContain('claude-code/claude-opus-5')
  })
})

describe('composite series key', () => {
  it('counts a retry of the same message id under a new request id', () => {
    const state = emptyState()
    ingest(state, transcript([message(), { ...message(), requestId: 'req_2' }]))
    const totals = state.daily[Object.keys(state.daily)[0]!]!['claude-code/claude-opus-5']!
    expect(totals.output).toBe(200)
    expect(totals.messages).toBe(2)
  })

  it('still folds repeated content blocks of one message', () => {
    const state = emptyState()
    ingest(state, transcript([message(), message()]))
    const totals = state.daily[Object.keys(state.daily)[0]!]!['claude-code/claude-opus-5']!
    expect(totals.output).toBe(100)
    expect(totals.messages).toBe(1)
  })

  it('(bug) does not double-count an in-flight message across the key upgrade', () => {
    // State written before composite keys holds a bare message id. Without the prefix carry-forward
    // in `sameSeries`, the next entry looks like a new series and its tokens are counted twice.
    const state = emptyState()
    const path = transcript([message()])
    state.files[path] = {
      offset: 0,
      size: 0,
      series: {
        msg_1: {
          id: 'msg_1',
          day: '2026-08-11',
          model: 'claude-code/claude-opus-5',
          project: 'project',
          counted: {
            input: 10,
            output: 100,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 5,
            messages: 1,
          },
        },
      },
    }
    ingest(state, path)
    const recorded = Object.values(state.daily).flatMap((byModel) =>
      Object.values(byModel).map(grandTotal),
    )
    expect(recorded.reduce((sum, value) => sum + value, 0)).toBe(0)
  })

  it('counts a message the stored bare id does not cover', () => {
    // The carry-forward matches on prefix only, so a different message is unaffected by it.
    const state = emptyState()
    const path = transcript([message()])
    state.files[path] = {
      offset: 0,
      size: 0,
      series: {
        msg_other: {
          id: 'msg_other',
          day: '2026-08-11',
          model: 'claude-code/claude-opus-5',
          project: 'project',
          counted: {
            input: 10,
            output: 100,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 5,
            messages: 1,
          },
        },
      },
    }
    ingest(state, path)
    expect(state.daily[Object.keys(state.daily)[0]!]!['claude-code/claude-opus-5']?.output).toBe(
      100,
    )
  })
})
