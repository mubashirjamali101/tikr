import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listTranscripts, scanAll } from '../src/core/scan.js'
import { emptyState } from '../src/core/types.js'

let dir: string
let previous: string | undefined

function transcript(relativePath: string, output: number): void {
  const path = join(dir, 'projects', relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: {
        id: `msg_${relativePath}`,
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: output },
      },
    })}\n`,
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-scan-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CODEX_HOME = join(dir, 'no-codex')
  process.env.COPILOT_HOME = join(dir, 'no-copilot')
})

afterEach(() => {
  // Remove rather than assign undefined: `process.env.X = undefined` stores the literal string
  // "undefined" in Node, which would leak a bogus path into every later test.
  if (previous === undefined) Reflect.deleteProperty(process.env, 'CLAUDE_CONFIG_DIR')
  else process.env.CLAUDE_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

describe('listTranscripts', () => {
  it('finds session transcripts directly under a project', () => {
    transcript('-Users-me-app/session.jsonl', 10)
    expect(listTranscripts()).toHaveLength(1)
  })

  it('(bug) finds subagent transcripts nested below the session directory', () => {
    // Subagent transcripts live at <project>/<session>/agent-<id>.jsonl. A flat two-level listing
    // silently dropped all subagent usage - 511 messages on the machine this was found on.
    transcript('-Users-me-app/session.jsonl', 10)
    transcript('-Users-me-app/session/agent-abc.jsonl', 20)
    transcript('-Users-me-app/vercel-plugin/skill-injections.jsonl', 5)

    expect(listTranscripts()).toHaveLength(3)
  })

  it('attributes a nested transcript to its top-level project', () => {
    transcript('-Users-me-app/session/agent-abc.jsonl', 20)
    expect(listTranscripts()[0]?.project).toBe('-Users-me-app')
  })

  it('ignores files that are not transcripts', () => {
    transcript('-Users-me-app/session.jsonl', 10)
    writeFileSync(join(dir, 'projects', '-Users-me-app', 'notes.txt'), 'hello')
    expect(listTranscripts()).toHaveLength(1)
  })

  it('returns nothing when the data directory does not exist', () => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'missing')
    expect(listTranscripts()).toEqual([])
  })
})

describe('scanAll', () => {
  it('totals usage across nested and top-level transcripts', () => {
    transcript('-Users-me-app/session.jsonl', 10)
    transcript('-Users-me-app/session/agent-abc.jsonl', 20)
    transcript('-Users-me-other/session.jsonl', 7)

    const state = emptyState()
    const result = scanAll(state)

    expect(result.messages).toBe(3)
    expect(result.byProvider['claude-code']).toEqual({ files: 3, messages: 3 })
    expect(state.projects['-Users-me-app']?.['claude-code/claude-opus-5']?.output).toBe(30)
    expect(state.projects['-Users-me-other']?.['claude-code/claude-opus-5']?.output).toBe(7)
    expect(state.lastScanAt).not.toBeNull()
  })
})
