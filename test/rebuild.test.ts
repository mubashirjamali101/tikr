import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyResult, ingestFile } from '../src/core/ingest.js'
import { applyKey, diffSnapshots, snapshotOf } from '../src/core/snapshot.js'
import { type State, emptyState, grandTotal } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'counter-rebuild-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

const MESSAGE = {
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
  },
}

function ingest(state: State, path: string): void {
  ingestFile(state, claudeProvider, path, 'project', emptyResult())
}

describe('ledger round trip', () => {
  it('rebuilds hourly buckets and limit events from deltas alone', () => {
    const state = emptyState()
    const before = snapshotOf(state)
    ingest(state, transcript([MESSAGE]))
    state.limits.events.push({ at: '2026-08-11T09:30:00.000Z', resetAt: null })
    const deltas = diffSnapshots(before, snapshotOf(state))

    const rebuilt = emptyState()
    for (const [key, value] of Object.entries(deltas)) applyKey(rebuilt, key, value)
    expect(rebuilt.hourly).toEqual(state.hourly)
    expect(rebuilt.daily).toEqual(state.daily)
    expect(rebuilt.limits.events).toEqual(state.limits.events)
  })

  it('keeps hourly out of the regression guard measure', () => {
    const state = emptyState()
    ingest(state, transcript([MESSAGE]))
    const daily = Object.values(state.daily).flatMap((byModel) =>
      Object.values(byModel).map(grandTotal),
    )
    // recordedTokens counts the day buckets only; hourly holds the same tokens a second time.
    expect(daily.reduce((sum, value) => sum + value, 0)).toBe(115)
  })
})

describe('limit events on replay', () => {
  it('(bug) a dropped event does not come back as a negative delta', () => {
    // The cap makes an old event disappear from the snapshot, which diffs to -1. Replaying that
    // as an event would resurrect what the cap had just discarded.
    const state = emptyState()
    applyKey(state, 'l|2026-08-11T09:00:00.000Z|-', -1)
    expect(state.limits.events).toEqual([])

    applyKey(state, 'l|2026-08-11T09:00:00.000Z|2026-08-11T14:00:00.000Z', 1)
    expect(state.limits.events).toEqual([
      { at: '2026-08-11T09:00:00.000Z', resetAt: '2026-08-11T14:00:00.000Z' },
    ])
  })
})
