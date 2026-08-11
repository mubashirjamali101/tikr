import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

describe('version', () => {
  it('matches package.json, so `--version` is never stale', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.version).toBe(VERSION)
  })
})
