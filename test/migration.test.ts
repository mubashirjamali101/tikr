import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The rename from claude-counter to tikr must carry the record over. The directory holds an
 * append-only encrypted ledger that cannot be rebuilt, so starting fresh would present as every
 * recorded token vanishing.
 */

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tikr-migration-'))
  vi.resetModules()
  Reflect.deleteProperty(process.env, 'TIKR_HOME')
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, homedir: () => home }
  })
})

afterEach(() => {
  vi.doUnmock('node:os')
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

describe('adopting the former state directory', () => {
  it('(bug) looks for the old directory name, not the current one', () => {
    // A repo-wide rename rewrote the constant to the new name, so the adoption compared the target
    // with itself and did nothing. Both sides of the test moved with it, so it still passed: the
    // one assertion that could catch this is the literal old name, stated here and nowhere else.
    const source = readFileSync(new URL('../src/core/paths.ts', import.meta.url), 'utf8')
    expect(source).toContain("const FORMER_HOME = '.claude-counter'")
  })

  it('moves it, contents intact', async () => {
    const former = join(home, '.claude-counter')
    mkdirSync(former, { recursive: true })
    writeFileSync(join(former, 'ledger.jsonl'), 'entry\n')
    writeFileSync(join(former, 'keyring.json'), '{"salt":"abc"}')

    const { counterHome } = await import('../src/core/paths.js')
    const adopted = counterHome()

    expect(adopted).toBe(join(home, '.tikr'))
    // The salt has to travel with the ledger or every record fails to decrypt.
    expect(readFileSync(join(adopted, 'ledger.jsonl'), 'utf8')).toBe('entry\n')
    expect(readFileSync(join(adopted, 'keyring.json'), 'utf8')).toContain('abc')
  })

  it('leaves an existing record alone', async () => {
    const former = join(home, '.claude-counter')
    mkdirSync(former, { recursive: true })
    writeFileSync(join(former, 'ledger.jsonl'), 'old\n')
    mkdirSync(join(home, '.tikr'), { recursive: true })
    writeFileSync(join(home, '.tikr', 'ledger.jsonl'), 'current\n')

    const { counterHome } = await import('../src/core/paths.js')
    expect(readFileSync(join(counterHome(), 'ledger.jsonl'), 'utf8')).toBe('current\n')
  })

  it('is a no-op on a fresh install', async () => {
    const { counterHome } = await import('../src/core/paths.js')
    expect(counterHome()).toBe(join(home, '.tikr'))
  })
})

describe('the former name itself', () => {
  it('(bug) is not the current one, which a blanket rename once made it', () => {
    // A search-and-replace across the tree rewrote the constant and this test together, so the
    // migration became "move ~/.tikr to ~/.tikr" and the suite stayed green. Asserting the literal
    // means the next such pass fails loudly instead.
    const source = readFileSync(new URL('../src/core/paths.ts', import.meta.url), 'utf8')
    expect(source).toContain("const FORMER_HOME = '.claude-counter'")
  })
})
