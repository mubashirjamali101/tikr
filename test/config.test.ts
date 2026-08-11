import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyConfig, configPath, loadConfig } from '../src/core/config.js'
import { parseArgs } from '../src/util/args.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-config-'))
  process.env.TIKR_HOME = dir
})

afterEach(() => {
  Reflect.deleteProperty(process.env, 'TIKR_HOME')
  rmSync(dir, { recursive: true, force: true })
})

function write(config: unknown): void {
  writeFileSync(configPath(), JSON.stringify(config))
}

describe('loadConfig', () => {
  it('is empty and silent when there is no file', () => {
    const config = loadConfig(true)
    expect(config.defaults).toEqual({})
    expect(config.problem).toBeNull()
  })

  it('reports a malformed file instead of failing the command', () => {
    writeFileSync(configPath(), '{ not json')
    const config = loadConfig(true)
    expect(config.problem).toContain('config.json')
    expect(config.defaults).toEqual({})
  })

  it('ignores keys it does not know', () => {
    write({ defaults: { by: 'week' }, nonsense: 42 })
    expect(loadConfig(true).defaults).toEqual({ by: 'week' })
  })
})

describe('precedence', () => {
  it('puts the flag first, then the command block, then defaults', () => {
    write({ defaults: { by: 'day' }, commands: { stats: { by: 'week' } } })
    const config = loadConfig(true)

    const typed = parseArgs(['stats', '--by', 'month'])
    applyConfig(typed, 'stats', config)
    expect(typed.flags.get('by')).toBe('month')

    const untyped = parseArgs(['stats'])
    applyConfig(untyped, 'stats', config)
    expect(untyped.flags.get('by')).toBe('week')

    const otherCommand = parseArgs(['scan'])
    applyConfig(otherCommand, 'scan', config)
    expect(otherCommand.flags.get('by')).toBe('day')
  })

  it('carries a boolean through as a bare flag', () => {
    write({ defaults: { 'no-scan': true } })
    const args = parseArgs(['stats'])
    applyConfig(args, 'stats', loadConfig(true))
    expect(args.flags.get('no-scan')).toBe(true)
  })
})

describe('boolean handling', () => {
  it('(bug) a false in config leaves the flag unset', () => {
    // Flags are read by presence, so storing `false` as the string "false" switched the option on.
    write({ defaults: { json: false, csv: true } })
    const args = parseArgs(['stats'])
    applyConfig(args, 'stats', loadConfig(true))
    expect(args.flags.has('json')).toBe(false)
    expect(args.flags.get('csv')).toBe(true)
  })
})
