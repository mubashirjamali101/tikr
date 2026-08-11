import { describe, expect, it } from 'vitest'
import { identifyBlocks } from '../src/core/blocks.js'
import { describeCeiling, estimateCeiling, nextReset, percentile } from '../src/core/ceiling.js'
import {
  emptyLimits,
  parseLimitEvent,
  parseResetTime,
  recordLimitEvent,
} from '../src/core/limits.js'
import { type State, emptyState, emptyTotals } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'

/**
 * Synthetic, not observed. The marker text is taken from ccusage's parser: of 217 local transcripts
 * checked on 2026-08-11, none contained it, so this fixture stands in until a real one is seen.
 */
const LIMIT_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-11T09:30:00.000Z',
  isApiErrorMessage: true,
  message: {
    id: 'msg_limit',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'Claude AI usage limit reached|1786000000' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
})

/** A real one from this machine: an error message that is not a limit. */
const CONNECTION_ERROR = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-11T07:48:27.277Z',
  isApiErrorMessage: true,
  message: {
    id: 'msg_error',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
})

describe('parseResetTime', () => {
  it('reads a seconds epoch', () => {
    expect(parseResetTime('Claude AI usage limit reached|1786000000')).toBe(
      new Date(1_786_000_000_000).toISOString(),
    )
  })

  it('reads a milliseconds epoch', () => {
    expect(parseResetTime('Claude AI usage limit reached|1786000000000')).toBe(
      new Date(1_786_000_000_000).toISOString(),
    )
  })

  it('returns null when the pipe or the digits are missing', () => {
    expect(parseResetTime('Claude AI usage limit reached')).toBeNull()
    expect(parseResetTime('Claude AI usage limit reached|soon')).toBeNull()
  })
})

describe('parseLimitEvent', () => {
  it('records the event and its reset time', () => {
    const event = parseLimitEvent(LIMIT_LINE, '2026-08-11T09:30:00.000Z')
    expect(event?.at).toBe('2026-08-11T09:30:00.000Z')
    expect(event?.resetAt).toBe(new Date(1_786_000_000_000).toISOString())
  })

  it('(bug) ignores an error message that is not a limit', () => {
    // All 8 real `isApiErrorMessage: true` entries on this machine are connection or auth errors.
    expect(parseLimitEvent(CONNECTION_ERROR, '2026-08-11T07:48:27.277Z')).toBeNull()
    expect(claudeProvider.parseSignal?.(CONNECTION_ERROR)).toBeNull()
  })

  it('ignores a transcript that merely quotes the marker', () => {
    const quoted = JSON.stringify({
      type: 'user',
      timestamp: '2026-08-11T09:30:00.000Z',
      message: { content: 'what does "Claude AI usage limit reached|123" mean?' },
    })
    expect(claudeProvider.parseSignal?.(quoted)).toBeNull()
  })

  it('carries no usage into any total', () => {
    expect(claudeProvider.parse(LIMIT_LINE, 'file')).toBeNull()
  })
})

describe('recordLimitEvent', () => {
  it('ignores a re-ingested duplicate', () => {
    const limits = emptyLimits()
    expect(recordLimitEvent(limits, { at: 'a', resetAt: null })).toBe(true)
    expect(recordLimitEvent(limits, { at: 'a', resetAt: null })).toBe(false)
    expect(limits.events).toHaveLength(1)
  })
})

function blocksWith(hours: string[], limitAt: string | null): { state: State } {
  const state = emptyState()
  for (const hour of hours) {
    state.hourly[hour] = { 'claude-code/claude-opus-5': { ...emptyTotals(), output: 1000 } }
  }
  if (limitAt !== null) recordLimitEvent(state.limits, { at: limitAt, resetAt: null })
  return { state }
}

describe('estimateCeiling', () => {
  it('is null before anything has completed', () => {
    expect(estimateCeiling([], emptyLimits())).toBeNull()
  })

  it('reports the largest completed block when no limit was ever hit', () => {
    const { state } = blocksWith(['2026-08-01T09', '2026-08-02T09', '2026-08-03T09'], null)
    const ceiling = estimateCeiling(
      identifyBlocks(state, { now: new Date('2026-09-01') }),
      state.limits,
    )
    expect(ceiling?.basis).toBe('observed')
    expect(describeCeiling(ceiling!)).toContain('no limit ever recorded')
  })

  it('uses the percentile of limit-bound blocks once there are enough of them', () => {
    const state = emptyState()
    const days = ['2026-08-01', '2026-08-02', '2026-08-03']
    for (const [index, day] of days.entries()) {
      state.hourly[`${day}T09`] = {
        'claude-code/claude-opus-5': { ...emptyTotals(), output: 1000 * (index + 1) },
      }
      // Local 09:30 on that day, expressed the way a transcript would record it.
      const at = new Date(`${day}T09:30:00`)
      recordLimitEvent(state.limits, { at: at.toISOString(), resetAt: null })
    }
    const ceiling = estimateCeiling(
      identifyBlocks(state, { now: new Date('2026-09-01') }),
      state.limits,
    )
    expect(ceiling?.basis).toBe('limited')
    expect(ceiling?.samples).toBe(3)
    expect(ceiling?.tokens).toBe(2800)
  })
})

describe('percentile and reset', () => {
  it('interpolates', () => {
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 6)
    expect(percentile([5], 0.9)).toBe(5)
    expect(percentile([], 0.9)).toBe(0)
  })

  it('ignores a reset time that has already passed', () => {
    const limits = emptyLimits()
    recordLimitEvent(limits, {
      at: '2026-08-11T09:00:00.000Z',
      resetAt: '2026-08-11T10:00:00.000Z',
    })
    expect(nextReset(limits, new Date('2026-08-11T09:30:00Z'))?.toISOString()).toBe(
      '2026-08-11T10:00:00.000Z',
    )
    expect(nextReset(limits, new Date('2026-08-11T11:00:00Z'))).toBeNull()
  })
})
