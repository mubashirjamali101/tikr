import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyResult } from '../src/core/ingest.js'
import { installedNeedOtlp, setupInstalled, wantOtlp } from '../src/core/setup.js'
import { emptyState } from '../src/core/types.js'
import { setupGrok } from '../src/providers/grok-setup.js'
import { daysForReport } from '../src/report/groups.js'
import { parseArgs } from '../src/util/args.js'
import { tomlTable, upsertTomlTable } from '../src/util/toml.js'

let dir: string
const saved: Record<string, string | undefined> = {}
const ENV = ['GROK_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME'] as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tikr-setup-'))
  for (const key of ENV) {
    saved[key] = process.env[key]
    process.env[key] = join(dir, `no-${key}`)
  }
})

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('upsertTomlTable', () => {
  it('creates a table when the file is empty', () => {
    const next = upsertTomlTable('', 'telemetry', { otel_enabled: 'true' })
    expect(next).toBe('[telemetry]\notel_enabled = true\n')
  })

  it('keeps unrelated keys and comments', () => {
    const raw = `[cli]\nyolo = true\n\n[telemetry]\n# keep me\nevents_url = "https://x"\n`
    const next = upsertTomlTable(raw, 'telemetry', { otel_enabled: 'true' })
    expect(next).toContain('# keep me')
    expect(next).toContain('events_url = "https://x"')
    expect(next).toContain('otel_enabled = true')
    expect(next).toContain('[cli]')
    expect(tomlTable(next, 'telemetry').events_url).toBe('https://x')
  })

  it('replaces an existing key rather than duplicating it', () => {
    const once = upsertTomlTable('[telemetry]\notel_enabled = false\n', 'telemetry', {
      otel_enabled: 'true',
    })
    const twice = upsertTomlTable(once, 'telemetry', { otel_enabled: 'true' })
    expect(once.match(/otel_enabled/g)).toHaveLength(1)
    expect(twice).toBe(once)
  })
})

describe('setupGrok', () => {
  it('writes loopback OTEL keys into a new config.toml', () => {
    process.env.GROK_HOME = dir
    const message = setupGrok({ otlpPort: 4318 })
    expect(message).toContain('configured')
    const raw = readFileSync(join(dir, 'config.toml'), 'utf8')
    expect(tomlTable(raw, 'telemetry')).toMatchObject({
      otel_enabled: 'true',
      otel_logs_exporter: 'otlp',
      otel_metrics_exporter: 'none',
      otel_endpoint: 'http://127.0.0.1:4318',
    })
  })

  it('is idempotent', () => {
    process.env.GROK_HOME = dir
    setupGrok({ otlpPort: 4318 })
    const first = readFileSync(join(dir, 'config.toml'), 'utf8')
    expect(setupGrok({ otlpPort: 4318 })).toContain('already pushing')
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(first)
  })

  it('(bug) does not steal a collector pointed off this machine', () => {
    process.env.GROK_HOME = dir
    writeFileSync(
      join(dir, 'config.toml'),
      '[telemetry]\notel_enabled = true\notel_endpoint = "https://collector.corp:4318"\n',
    )
    const message = setupGrok({ otlpPort: 4318 })
    expect(message).toContain('left existing OTEL endpoint')
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('collector.corp')
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).not.toContain('127.0.0.1')
  })

  it('updates a previous tikr loopback port in place', () => {
    process.env.GROK_HOME = dir
    writeFileSync(
      join(dir, 'config.toml'),
      '[telemetry]\notel_enabled = true\notel_logs_exporter = "otlp"\notel_endpoint = "http://127.0.0.1:9999"\n',
    )
    setupGrok({ otlpPort: 4318 })
    expect(
      tomlTable(readFileSync(join(dir, 'config.toml'), 'utf8'), 'telemetry').otel_endpoint,
    ).toBe('http://127.0.0.1:4318')
  })
})

describe('wantOtlp', () => {
  it('is off when no OTLP-only tool is installed', () => {
    expect(installedNeedOtlp()).toBe(false)
    expect(wantOtlp(parseArgs(['start']))).toBe(false)
  })

  it('turns on when Grok is installed, unless --no-otlp', () => {
    process.env.GROK_HOME = dir
    mkdirSync(dir, { recursive: true })
    expect(installedNeedOtlp()).toBe(true)
    expect(wantOtlp(parseArgs(['start']))).toBe(true)
    expect(wantOtlp(parseArgs(['start', '--no-otlp']))).toBe(false)
    expect(wantOtlp(parseArgs(['start', '--otlp', '--no-otlp']))).toBe(false)
  })

  it('honours an explicit --otlp even with no Grok', () => {
    expect(wantOtlp(parseArgs(['start', '--otlp']))).toBe(true)
  })
})

describe('setupInstalled', () => {
  it('reports indexed history for every file-backed tool that is present', () => {
    process.env.CLAUDE_CONFIG_DIR = dir
    mkdirSync(join(dir, 'projects'), { recursive: true })
    const result = emptyResult()
    result.byProvider['claude-code'] = { files: 2, messages: 9 }
    expect(setupInstalled(4318, result, false, false)).toEqual([
      'Claude Code: 2 files, 9 messages from existing history',
    ])
  })

  it('says Grok cannot be backfilled from files', () => {
    process.env.GROK_HOME = dir
    mkdirSync(dir, { recursive: true })
    const lines = setupInstalled(4318, emptyResult(), false, true)
    expect(lines.some((line) => line.startsWith('Grok:'))).toBe(true)
    expect(lines.join('\n')).not.toMatch(/Grok: \d+ files/)
  })
})

describe('daysForReport', () => {
  it('widens an empty default window to all recorded days', () => {
    const state = emptyState()
    state.daily['2026-03-01'] = {}
    const { days, widened } = daysForReport(state, '2026-07-01', null, false)
    expect(widened).toBe(true)
    expect(days).toEqual(['2026-03-01'])
  })

  it('does not widen when the user pinned the window', () => {
    const state = emptyState()
    state.daily['2026-03-01'] = {}
    expect(daysForReport(state, '2026-07-01', null, true)).toEqual({
      days: [],
      widened: false,
    })
  })
})
