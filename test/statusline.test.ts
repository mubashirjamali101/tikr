import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identifyBlocks } from '../src/core/blocks.js'
import { commit } from '../src/core/commit.js'
import { emptyResult, ingestFile } from '../src/core/ingest.js'
import { findSessionFile, readSession } from '../src/core/session.js'
import { loadState } from '../src/core/state.js'
import { emptyState, emptyTotals } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'
import { renderStatusline } from '../src/report/statusline.js'

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function line(id: string, output: number, timestamp = '2026-08-11T09:15:00.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    requestId: `req_${id}`,
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0 },
    },
  })
}

let home: string
let claude: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'counter-statusline-'))
  claude = mkdtempSync(join(tmpdir(), 'claude-home-'))
  process.env.TIKR_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
})

afterEach(() => {
  process.env.TIKR_HOME = undefined
  process.env.CLAUDE_CONFIG_DIR = undefined
})

function writeTranscript(project: string, lines: string[]): string {
  const dir = join(claude, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${SESSION}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('session lookup', () => {
  it('finds the transcript from the working directory', () => {
    const path = writeTranscript('-Users-me-code-my-app', [line('a', 100)])
    expect(findSessionFile(SESSION, '/Users/me/code/tikr')).toBe(path)
  })

  it('falls back to a search when the session was resumed elsewhere', () => {
    const path = writeTranscript('-Users-me-code-other', [line('a', 100)])
    expect(findSessionFile(SESSION, '/Users/me/code/tikr')).toBe(path)
  })

  it('returns null rather than throwing when nothing matches', () => {
    expect(findSessionFile(SESSION, null)).toBeNull()
  })
})

describe('readSession', () => {
  it('folds a transcript the same way the ingest path does', () => {
    const path = writeTranscript('-Users-me-code-my-app', [
      line('a', 100),
      line('a', 100),
      line('b', 50),
    ])
    const session = readSession(path)
    const state = emptyState()
    ingestFile(state, claudeProvider, path, 'project', emptyResult())
    const day = Object.values(state.daily)[0]!
    expect(session.totals.output).toBe(day['claude-code/claude-opus-5']?.output)
    expect(session.totals.messages).toBe(2)
  })

  it('is empty for a file that does not exist', () => {
    expect(readSession(join(claude, 'missing.jsonl')).totals).toEqual(emptyTotals())
  })

  it('(bug) never writes state or the ledger', () => {
    // The statusline runs on every prompt render. Ingesting here would race the daemon for both
    // files, and lock contention in the prompt path shows up as a hang while typing.
    const path = writeTranscript('-Users-me-code-my-app', [line('a', 100)])
    const state = loadState().state
    commit(state, 'transcript', (draft) => {
      ingestFile(draft, claudeProvider, path, 'project', emptyResult())
    })

    const files = [join(home, 'state.json'), join(home, 'ledger.jsonl')]
    const before = files.map((file) =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent',
    )
    readSession(path)
    findSessionFile(SESSION, '/Users/me/code/tikr')
    identifyBlocks(loadState().state)
    const after = files.map((file) =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent',
    )
    expect(after).toEqual(before)
  })
})

describe('renderStatusline', () => {
  const base = {
    model: 'Opus 5',
    sessionCostUsd: 1.235,
    todayCostUsd: 18.4,
    block: {
      startHour: '2026-08-11T09',
      startsAt: new Date('2026-08-11T09:00:00'),
      endsAt: new Date('2026-08-11T14:00:00'),
      isActive: true,
      isGap: false,
      byModel: {},
      totals: emptyTotals(),
      costUsd: 6.1,
    },
    burn: { tokensPerMinute: 3400, tokensPerMinuteExcludingCache: 120, costPerHour: 4 },
    now: new Date('2026-08-11T11:49:00'),
  }

  it('shows every field when there is room', () => {
    const line = renderStatusline(base)
    expect(line).toBe(
      'Opus 5  session $1.24  today $18.40  block $6.10 (2h 11m left)  3.4K tok/min',
    )
  })

  it('drops fields from the right as the terminal narrows', () => {
    expect(renderStatusline(base, 50)).toBe('Opus 5  session $1.24  today $18.40')
    expect(renderStatusline(base, 20)).toBe('Opus 5')
  })

  it('omits the session cost when the transcript could not be resolved', () => {
    expect(renderStatusline({ ...base, sessionCostUsd: null })).not.toContain('session')
  })

  it('omits the block when none is active', () => {
    const line = renderStatusline({ ...base, block: null, burn: null })
    expect(line).toBe('Opus 5  session $1.24  today $18.40')
  })
})
