import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { counterHome, statePath } from '../src/core/paths.js'
import { scanAll } from '../src/core/scan.js'
import { StateRegressionError, loadState, saveState } from '../src/core/state.js'
import { emptyState, recordedTokens } from '../src/core/types.js'

let home: string
let claude: string
let previousHome: string | undefined
let previousClaude: string | undefined

function transcript(name: string, output: number): string {
  const dir = join(claude, 'projects', '-Users-me-app')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: {
        id: `msg_${name}`,
        model: 'claude-opus-5',
        usage: { input_tokens: 0, output_tokens: output },
      },
    })}\n`,
  )
  return path
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-home-'))
  claude = mkdtempSync(join(tmpdir(), 'cc-claude-'))
  previousHome = process.env.TIKR_HOME
  previousClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.TIKR_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  // scanAll walks every provider, so the others must be pointed somewhere empty or real Codex and
  // Copilot data on the developer's machine leaks into the assertions.
  process.env.CODEX_HOME = join(claude, 'no-codex')
  process.env.COPILOT_HOME = join(claude, 'no-copilot')
})

afterEach(() => {
  for (const [key, value] of [
    ['TIKR_HOME', previousHome],
    ['CLAUDE_CONFIG_DIR', previousClaude],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(claude, { recursive: true, force: true })
})

describe('the record survives Claude Code deleting its transcripts', () => {
  it('(bug) keeps counted tokens after the source transcript is deleted', () => {
    // Claude Code deletes sessions older than cleanupPeriodDays (30 by default) at startup. A tool
    // that recomputes from the files on disk reports a shrinking total; this one must not.
    const old = transcript('old.jsonl', 30_000_000)
    transcript('recent.jsonl', 70_000_000)

    const first = loadState().state
    scanAll(first)
    saveState(first)
    expect(recordedTokens(first)).toBe(100_000_000)

    rmSync(old)

    const second = loadState().state
    scanAll(second)
    saveState(second)
    expect(recordedTokens(second)).toBe(100_000_000)
  })

  it('reports how many counted transcripts have been deleted', () => {
    transcript('a.jsonl', 10)
    const path = transcript('b.jsonl', 20)

    const state = loadState().state
    scanAll(state)
    expect(state.pruned.count).toBe(0)

    rmSync(path)
    scanAll(state)

    expect(state.pruned.count).toBe(1)
    expect(state.pruned.lastAt).not.toBeNull()
  })

  it('does not re-count a transcript that reappears after being seen', () => {
    const path = transcript('a.jsonl', 10)
    const state = loadState().state
    scanAll(state)
    rmSync(path)
    scanAll(state)
    transcript('a.jsonl', 10)
    scanAll(state)

    expect(recordedTokens(state)).toBe(10)
  })
})

describe('saveState refuses to lose recorded usage', () => {
  it('(bug) rejects a write that would shrink the total', () => {
    // Without this guard, a corrupt-state reset followed by a normal save silently replaces the
    // full history with whatever transcripts still exist.
    const full = emptyState()
    full.daily['2026-08-11'] = {
      'claude-opus-5': {
        input: 0,
        output: 100,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        messages: 1,
      },
    }
    saveState(full)

    expect(() => saveState(emptyState())).toThrow(StateRegressionError)
    expect(recordedTokens(loadState().state)).toBe(100)
  })

  it('allows a deliberate reset through force', () => {
    const full = emptyState()
    full.daily.x = {
      m: { input: 0, output: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1 },
    }
    saveState(full)
    expect(() => saveState(emptyState(), { force: true })).not.toThrow()
  })

  it('allows a write that grows the total', () => {
    const state = emptyState()
    state.daily.x = {
      m: { input: 0, output: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1 },
    }
    saveState(state)
    state.daily.x.m.output = 50
    expect(() => saveState(state)).not.toThrow()
    expect(recordedTokens(loadState().state)).toBe(50)
  })
})

describe('a damaged state file does not erase the record', () => {
  it('(bug) recovers from the backup instead of starting over', () => {
    const state = emptyState()
    state.daily.x = {
      m: { input: 0, output: 999, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1 },
    }
    saveState(state)
    // A second write promotes the first file to the backup slot.
    state.daily.x.m.output = 1000
    saveState(state)

    writeFileSync(statePath(), 'truncated garbage {{{')

    const { state: recovered, reset } = loadState()
    expect(reset).toBe('recovered')
    expect(recordedTokens(recovered)).toBe(999)
  })

  it('keeps the damaged file for inspection rather than overwriting it', () => {
    saveState(emptyState())
    writeFileSync(statePath(), 'garbage')
    loadState()

    const quarantined = readdirSync(counterHome()).filter((name) => name.includes('.corrupt-'))
    expect(quarantined.length).toBeGreaterThan(0)
  })

  it('reports a clean start only when there is genuinely nothing to recover', () => {
    expect(loadState().reset).toBe('missing')
    expect(existsSync(statePath())).toBe(false)
  })
})

describe('--no-backfill', () => {
  it('starts counting from now instead of reading existing history', () => {
    transcript('history.jsonl', 5_000_000)

    const state = loadState().state
    scanAll(state, { seedOnly: true })
    expect(recordedTokens(state)).toBe(0)

    // Anything appended afterwards is still counted normally.
    appendFileSync(
      join(claude, 'projects', '-Users-me-app', 'history.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T13:00:00.000Z',
        message: { id: 'msg_new', model: 'claude-opus-5', usage: { output_tokens: 42 } },
      })}\n`,
    )
    scanAll(state)
    expect(recordedTokens(state)).toBe(42)
  })
})
