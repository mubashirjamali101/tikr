import { describe, expect, it } from 'vitest'
import { flagBool, flagInt, flagString, parseArgs } from '../src/util/args.js'

describe('parseArgs', () => {
  it('reads the command and space-separated flag values', () => {
    const args = parseArgs(['stats', '--days', '7', '--by', 'day'])
    expect(args.command).toBe('stats')
    expect(flagString(args, 'days')).toBe('7')
    expect(flagString(args, 'by')).toBe('day')
  })

  it('reads equals-separated flag values', () => {
    const args = parseArgs(['stats', '--days=7'])
    expect(flagString(args, 'days')).toBe('7')
  })

  it('treats a flag followed by another flag as a boolean', () => {
    const args = parseArgs(['scan', '--dry-run', '--verbose'])
    expect(flagBool(args, 'dry-run')).toBe(true)
    expect(flagBool(args, 'verbose')).toBe(true)
    expect(flagString(args, 'dry-run')).toBeNull()
  })

  it('treats a trailing flag as a boolean', () => {
    expect(flagBool(parseArgs(['stats', '--json']), 'json')).toBe(true)
  })

  it('collects extra positionals after the command', () => {
    expect(parseArgs(['stats', 'extra', 'more']).positional).toEqual(['extra', 'more'])
  })

  it('handles an empty argv', () => {
    expect(parseArgs([]).command).toBe('')
  })
})

describe('flagInt', () => {
  it('parses a positive integer', () => {
    expect(flagInt(parseArgs(['x', '--n', '42']), 'n', 7)).toBe(42)
  })

  it('falls back when absent, zero, negative, or not a number', () => {
    expect(flagInt(parseArgs(['x']), 'n', 7)).toBe(7)
    expect(flagInt(parseArgs(['x', '--n', '0']), 'n', 7)).toBe(7)
    expect(flagInt(parseArgs(['x', '--n', '-3']), 'n', 7)).toBe(7)
    expect(flagInt(parseArgs(['x', '--n', 'abc']), 'n', 7)).toBe(7)
  })
})

describe('flagInt minimum', () => {
  it('(bug) accepts 0 when the caller allows it', () => {
    // `--days 0` means "all history". Rejecting 0 as invalid silently fell back to the default
    // 30-day window, hiding older usage without any indication.
    expect(flagInt(parseArgs(['stats', '--days', '0']), 'days', 30, 0)).toBe(0)
  })

  it('still rejects 0 for flags where it is meaningless', () => {
    expect(flagInt(parseArgs(['start', '--interval', '0']), 'interval', 15)).toBe(15)
  })

  it('rejects values below an explicit minimum', () => {
    expect(flagInt(parseArgs(['x', '--n', '-1']), 'n', 7, 0)).toBe(7)
  })
})
