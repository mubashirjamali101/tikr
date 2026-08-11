import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commit, recoverFromLedger } from '../src/core/commit.js'
import { readPayloads, verifyLedger } from '../src/core/ledger-verify.js'
import { appendEntry, ledgerPath } from '../src/core/ledger.js'
import { statePath } from '../src/core/paths.js'
import { loadState, saveState } from '../src/core/state.js'
import { emptyState, recordedTokens } from '../src/core/types.js'
import { SealError, open, resetKeyCache, seal } from '../src/crypto/seal.js'

let home: string
let previous: string | undefined

function bump(output: number, day = '2026-08-11') {
  return (state: ReturnType<typeof emptyState>) => {
    const byModel = state.daily[day] ?? {}
    const totals = byModel['claude-opus-5'] ?? {
      input: 0,
      output: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      messages: 0,
    }
    totals.output += output
    totals.messages += 1
    byModel['claude-opus-5'] = totals
    state.daily[day] = byModel
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-ledger-'))
  previous = process.env.TIKR_HOME
  process.env.TIKR_HOME = home
  resetKeyCache()
})

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, 'TIKR_HOME')
  else process.env.TIKR_HOME = previous
  resetKeyCache()
  rmSync(home, { recursive: true, force: true })
})

describe('encryption at rest', () => {
  it('round-trips through seal and open', () => {
    expect(open(seal('hello ledger'))).toBe('hello ledger')
  })

  it('writes no readable plaintext to disk', () => {
    const state = emptyState()
    bump(123_456)(state)
    saveState(state)

    const raw = readFileSync(statePath(), 'utf8')
    expect(raw).not.toContain('claude-opus-5')
    expect(raw).not.toContain('123456')
    expect(raw).toContain('"iv"')
  })

  it('(bug) rejects an edited ciphertext rather than returning altered data', () => {
    // Authenticated encryption is what makes stored history non-editable: without the tag check a
    // flipped byte would silently change a token count.
    const sealed = seal('output=100')
    const bytes = Buffer.from(sealed.ct, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    expect(() => open({ ...sealed, ct: bytes.toString('base64') })).toThrow(SealError)
  })

  it('rejects a record sealed with a different key, as another machine would produce', () => {
    const foreign = seal('secret', Buffer.alloc(32, 7))
    expect(() => open(foreign)).toThrow(SealError)
  })
})

describe('the ledger chain', () => {
  it('links each entry to the one before it', () => {
    const first = appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    const second = appendEntry({ at: 'b', source: 'transcript', deltas: { x: 2 } })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.prev).toBe(first.hash)
    expect(verifyLedger()).toMatchObject({ ok: true, entries: 2, brokenAt: null })
  })

  it('preserves payloads in order', () => {
    appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    appendEntry({ at: 'b', source: 'telemetry', deltas: { y: 2 } })
    const payloads = readPayloads()
    expect(payloads.map((p) => p.at)).toEqual(['a', 'b'])
    expect(payloads[1]?.source).toBe('telemetry')
  })

  it('(bug) detects a removed entry', () => {
    // Deleting a line is the obvious way to erase history; the sequence and chain links catch it.
    appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    appendEntry({ at: 'b', source: 'transcript', deltas: { x: 2 } })
    appendEntry({ at: 'c', source: 'transcript', deltas: { x: 3 } })

    const lines = readFileSync(ledgerPath(), 'utf8').trim().split('\n')
    writeFileSync(ledgerPath(), `${[lines[0], lines[2]].join('\n')}\n`)

    const result = verifyLedger()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
  })

  it('(bug) detects an edited entry', () => {
    appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    const line = JSON.parse(readFileSync(ledgerPath(), 'utf8').trim())
    const bytes = Buffer.from(line.body.ct, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    line.body.ct = bytes.toString('base64')
    writeFileSync(ledgerPath(), `${JSON.stringify(line)}\n`)

    const result = verifyLedger()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('hash does not match')
  })

  it('detects an appended entry that was not produced by this tool', () => {
    appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    appendFileSync(
      ledgerPath(),
      `${JSON.stringify({ seq: 2, prev: 'x'.repeat(64), hash: 'y'.repeat(64), body: seal('{}') })}\n`,
    )
    expect(verifyLedger()).toMatchObject({ ok: false, brokenAt: 2 })
  })

  it('detects a reordered pair', () => {
    appendEntry({ at: 'a', source: 'transcript', deltas: { x: 1 } })
    appendEntry({ at: 'b', source: 'transcript', deltas: { x: 2 } })
    const lines = readFileSync(ledgerPath(), 'utf8').trim().split('\n')
    writeFileSync(ledgerPath(), `${[lines[1], lines[0]].join('\n')}\n`)
    expect(verifyLedger().ok).toBe(false)
  })

  it('reports an empty ledger as intact', () => {
    expect(verifyLedger()).toMatchObject({ ok: true, entries: 0 })
  })
})

describe('commit and recovery', () => {
  it('records a ledger entry for every change', () => {
    const state = loadState().state
    commit(state, 'transcript', bump(100))
    commit(state, 'transcript', bump(50))

    expect(verifyLedger().entries).toBe(2)
    expect(recordedTokens(loadState().state)).toBe(150)
  })

  it('writes nothing when a mutation changes nothing', () => {
    const state = loadState().state
    commit(state, 'transcript', bump(10))
    const deltas = commit(state, 'transcript', () => {})
    expect(deltas).toBeNull()
    expect(verifyLedger().entries).toBe(1)
  })

  it('(bug) rebuilds the totals after the cache is destroyed', () => {
    // This is the guarantee that matters: the ledger, not state.json, is the record.
    const state = loadState().state
    commit(state, 'transcript', bump(700))
    commit(state, 'transcript', bump(300))
    expect(recordedTokens(loadState().state)).toBe(1000)

    rmSync(statePath())
    rmSync(join(home, 'state.backup.json'), { force: true })
    expect(recordedTokens(loadState().state)).toBe(0)

    const recovery = recoverFromLedger()
    expect(recovery.rebuilt).toBe(true)
    expect(recordedTokens(loadState().state)).toBe(1000)
  })

  it('restores read offsets too, so a rebuild does not re-count transcripts', () => {
    const state = loadState().state
    commit(state, 'transcript', (draft) => {
      bump(10)(draft)
      draft.files['/a/session.jsonl'] = { offset: 4096, size: 4096, lastMessage: null }
    })
    rmSync(statePath())
    rmSync(join(home, 'state.backup.json'), { force: true })
    recoverFromLedger()

    expect(loadState().state.files['/a/session.jsonl']?.offset).toBe(4096)
  })

  it('(bug) refuses to rebuild from a tampered ledger', () => {
    // Rebuilding from a broken chain would launder altered numbers into a clean-looking cache.
    const state = loadState().state
    commit(state, 'transcript', bump(500))
    appendFileSync(ledgerPath(), 'not a ledger line\n')
    rmSync(statePath())

    const recovery = recoverFromLedger()
    expect(recovery.rebuilt).toBe(false)
    expect(recovery.reason).toContain('failed verification')
  })

  it('leaves an up-to-date cache alone', () => {
    const state = loadState().state
    commit(state, 'transcript', bump(42))
    const recovery = recoverFromLedger()
    expect(recovery.rebuilt).toBe(false)
    expect(recovery.reason).toContain('already holds')
  })
})

describe('appending after a very large entry', () => {
  it('(bug) continues the sequence when the previous entry exceeds the tail read window', () => {
    // The initial backfill entry is tens of kilobytes. A tail read smaller than that returns a
    // fragment, which was mistaken for "no entries" and restarted the sequence at 1, breaking the
    // chain on the very next append.
    const big: Record<string, number> = {}
    for (let i = 0; i < 4000; i += 1) big[`d|2026-08-11|model-${i}|output`] = i
    appendEntry({ at: 'big', source: 'transcript', deltas: big })
    expect(readFileSync(ledgerPath(), 'utf8').length).toBeGreaterThan(50_000)

    const second = appendEntry({ at: 'after', source: 'transcript', deltas: { x: 1 } })

    expect(second.seq).toBe(2)
    expect(verifyLedger()).toMatchObject({ ok: true, entries: 2 })
  })

  it('keeps the chain intact across many appends of varying size', () => {
    for (let i = 0; i < 25; i += 1) {
      const deltas: Record<string, number> = {}
      const width = i % 5 === 0 ? 2000 : 3
      for (let k = 0; k < width; k += 1) deltas[`d|2026-08-11|m${k}|output`] = k + 1
      appendEntry({ at: `e${i}`, source: 'transcript', deltas })
    }
    expect(verifyLedger()).toMatchObject({ ok: true, entries: 25 })
  })
})
