import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statePath } from '../src/core/paths.js'
import { describeReset, loadState, saveState } from '../src/core/state.js'
import { emptyState } from '../src/core/types.js'

let dir: string
let previous: string | undefined

const V1_TOTALS = {
  input: 10,
  output: 20,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  messages: 1,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-state-'))
  previous = process.env.TIKR_HOME
  process.env.TIKR_HOME = dir
})

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, 'TIKR_HOME')
  else process.env.TIKR_HOME = previous
  rmSync(dir, { recursive: true, force: true })
})

describe('loadState', () => {
  it('returns an empty record when no state exists yet', () => {
    const { state, reset } = loadState()
    expect(reset).toBe('missing')
    expect(state.daily).toEqual({})
    expect(state.otel.active).toBe(false)
  })

  it('round-trips through save', () => {
    const original = emptyState()
    original.daily['2026-08-11'] = { 'claude-opus-5': { ...V1_TOTALS } }
    saveState(original)

    const { state, reset } = loadState()
    expect(reset).toBe('none')
    expect(state.daily['2026-08-11']?.['claude-opus-5']).toMatchObject({ output: 20 })
  })

  it('(bug) migrates a version 1 file instead of discarding its statistics', () => {
    // A reset here is permanent data loss: ingested transcript bytes are never re-read, so the
    // history cannot be rebuilt by rescanning. Version 2 only adds the telemetry section.
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        files: { '/some/session.jsonl': { offset: 42, size: 42, lastMessage: null } },
        daily: { '2026-08-11': { 'claude-opus-5': V1_TOTALS } },
        projects: { '-Users-me-app': { 'claude-opus-5': V1_TOTALS } },
      }),
    )

    const { state, reset } = loadState()
    expect(reset).toBe('none')
    expect(state.daily['2026-08-11']?.['claude-opus-5']?.output).toBe(20)
    expect(state.projects['-Users-me-app']).toBeDefined()
    expect(state.files['/some/session.jsonl']?.offset).toBe(42)
    // The added section is filled in with defaults rather than left undefined.
    expect(state.otel).toMatchObject({ active: false, daily: {}, costUsd: {} })
  })

  it('starts fresh on a state file from an unknown future version', () => {
    writeFileSync(statePath(), JSON.stringify({ version: 999, daily: { x: {} } }))
    const { state, reset } = loadState()
    expect(reset).toBe('version')
    expect(state.daily).toEqual({})
  })

  it('starts fresh rather than crashing on an unreadable file', () => {
    writeFileSync(statePath(), 'not json at all {{{')
    const { reset } = loadState()
    expect(reset).toBe('corrupt')
  })

  it('fills in defaults for a truncated but valid state file', () => {
    writeFileSync(statePath(), JSON.stringify({ version: 2 }))
    const { state, reset } = loadState()
    expect(reset).toBe('none')
    expect(state.files).toEqual({})
    expect(state.otel.active).toBe(false)
  })
})

describe('describeReset', () => {
  it('explains only the cases that lose data', () => {
    expect(describeReset('none')).toBeNull()
    expect(describeReset('missing')).toBeNull()
    expect(describeReset('corrupt')).toContain('could not be read')
    expect(describeReset('version')).toContain('incompatible version')
  })
})

describe('version 3 migration', () => {
  it('loads a version 2 file and starts the new sections empty', () => {
    // Discarding it would be permanent loss: the transcript bytes behind those totals are gone.
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 2,
        createdAt: '2026-07-01T00:00:00.000Z',
        daily: { '2026-07-01': { 'claude-code/claude-opus-5': V1_TOTALS } },
        files: {},
        projects: {},
        otel: {
          active: false,
          lastEventAt: null,
          daily: {},
          costUsd: {},
          bySource: {},
          cumulative: {},
        },
      }),
    )
    const { state, reset } = loadState()
    expect(reset).toBe('none')
    expect(state.daily['2026-07-01']?.['claude-code/claude-opus-5']?.output).toBe(20)
    expect(state.hourly).toEqual({})
    expect(state.limits).toEqual({ events: [], dropped: 0 })
    expect(state.otel.counters).toEqual({})
    expect(state.lastActivityAt).toBeNull()
  })

  it('(bug) a migrated file still saves, rather than tripping the regression guard', () => {
    // recordedTokens reads the day buckets only, so the empty hourly section must not look like a
    // loss of tokens when the file is written back at version 3.
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 2,
        daily: { '2026-07-01': { 'claude-code/claude-opus-5': V1_TOTALS } },
        files: {},
        projects: {},
      }),
    )
    const { state } = loadState()
    expect(() => saveState(state)).not.toThrow()
    expect(loadState().state.version).toBe(3)
  })

  it('rejects a file from a future version rather than guessing at its shape', () => {
    writeFileSync(statePath(), JSON.stringify({ version: 99, daily: {} }))
    expect(loadState().reset).toBe('version')
  })
})
