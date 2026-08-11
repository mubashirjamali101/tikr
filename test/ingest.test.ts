import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyResult, ingestFile } from '../src/core/ingest.js'
import { type State, emptyState } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'

let dir: string
let file: string

function line(id: string, output: number, day = '2026-08-11T12:00:00.000Z'): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: day,
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0 },
    },
  })}\n`
}

function ingest(state: State) {
  const result = emptyResult()
  ingestFile(state, claudeProvider, file, 'proj', result)
  return result
}

function totalOutput(state: State): number {
  let sum = 0
  for (const byModel of Object.values(state.daily)) {
    for (const totals of Object.values(byModel)) sum += totals.output
  }
  return sum
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-ingest-'))
  file = join(dir, 'session.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ingestFile', () => {
  it('ingests a whole file on first pass', () => {
    writeFileSync(file, line('a', 10) + line('b', 20))
    const state = emptyState()
    const result = ingest(state)

    expect(result.messages).toBe(2)
    expect(totalOutput(state)).toBe(30)
  })

  it('(bug) reads only appended bytes on a second pass, not the whole file again', () => {
    // Re-reading from zero would double every total on every scan interval.
    writeFileSync(file, line('a', 10))
    const state = emptyState()
    ingest(state)

    appendFileSync(file, line('b', 20))
    const second = ingest(state)

    expect(second.messages).toBe(1)
    expect(totalOutput(state)).toBe(30)
  })

  it('records nothing when the file has not changed', () => {
    writeFileSync(file, line('a', 10))
    const state = emptyState()
    ingest(state)
    const second = ingest(state)

    expect(second.messages).toBe(0)
    expect(totalOutput(state)).toBe(10)
  })

  it('(bug) leaves a partially written final line for the next pass', () => {
    // A live session flushes mid-line; parsing the fragment would drop that message entirely.
    const complete = line('a', 10)
    const partial = line('b', 20)
    writeFileSync(file, complete + partial.slice(0, 30))

    const state = emptyState()
    expect(ingest(state).messages).toBe(1)

    writeFileSync(file, complete + partial)
    expect(ingest(state).messages).toBe(1)
    expect(totalOutput(state)).toBe(30)
  })

  it('carries message dedupe across a chunk boundary', () => {
    // The two entries for one message can land in different scan passes.
    const dup = line('a', 10)
    writeFileSync(file, dup)
    const state = emptyState()
    ingest(state)

    appendFileSync(file, line('a', 99))
    ingest(state)

    expect(totalOutput(state)).toBe(99)
    expect(state.daily['2026-08-11']?.['claude-code/claude-opus-5']?.messages).toBe(1)
  })

  it('(bug) resyncs without re-ingesting when a transcript shrinks', () => {
    // A rewritten file must not be counted twice; we resync to the new end and record why.
    writeFileSync(file, line('a', 10) + line('b', 20))
    const state = emptyState()
    ingest(state)
    expect(totalOutput(state)).toBe(30)

    writeFileSync(file, line('c', 5))
    const result = ingest(state)

    expect(result.resyncs).toBe(1)
    expect(state.resyncs).toBe(1)
    expect(totalOutput(state)).toBe(30)
    expect(state.files[file]?.series).toEqual({})
  })

  it('survives a file that disappears between listing and reading', () => {
    const state = emptyState()
    const result = emptyResult()
    ingestFile(state, claudeProvider, join(dir, 'gone.jsonl'), 'proj', result)

    expect(result.messages).toBe(0)
    expect(result.filesSeen).toBe(1)
  })

  it('handles multi-byte characters without misaligning the offset', () => {
    const withEmoji = `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: {
        id: 'a',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'héllo → 世界' }],
        usage: { input_tokens: 1, output_tokens: 10 },
      },
    })}\n`
    writeFileSync(file, withEmoji)
    const state = emptyState()
    ingest(state)

    appendFileSync(file, line('b', 20))
    ingest(state)

    expect(totalOutput(state)).toBe(30)
  })
})
