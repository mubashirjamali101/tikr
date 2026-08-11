import { describe, expect, it } from 'vitest'
import { identifyBlocks, lastActivity } from '../src/core/blocks.js'
import { activeBlock, burnRate, project } from '../src/core/burn.js'
import { type State, emptyState, emptyTotals } from '../src/core/types.js'
import { renderBlocks } from '../src/report/blocks.js'

function stateWith(hours: Record<string, number>, lastActivityAt: string | null = null): State {
  const state = emptyState()
  for (const [hour, output] of Object.entries(hours)) {
    state.hourly[hour] = {
      'claude-code/claude-opus-5': { ...emptyTotals(), output, messages: 1 },
    }
  }
  state.lastActivityAt = lastActivityAt
  return state
}

/** Local ISO for a fixed local hour, so the test does not depend on the machine's timezone. */
function at(hour: string, minute = 0): Date {
  const [day, clock] = hour.split('T') as [string, string]
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date, Number(clock), minute)
}

describe('identifyBlocks', () => {
  it('groups consecutive hours into one five-hour block', () => {
    const state = stateWith({
      '2026-08-11T09': 100,
      '2026-08-11T10': 200,
      '2026-08-11T11': 300,
    })
    const blocks = identifyBlocks(state, { now: at('2026-08-12T09') })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.startHour).toBe('2026-08-11T09')
    expect(blocks[0]?.totals.output).toBe(600)
  })

  it('closes a block when the window expires and starts another', () => {
    const state = stateWith({
      '2026-08-11T09': 100,
      '2026-08-11T13': 100,
      '2026-08-11T14': 100,
    })
    const blocks = identifyBlocks(state, { now: at('2026-08-12T09') })
    expect(blocks.filter((block) => !block.isGap)).toHaveLength(2)
    expect(blocks[0]?.totals.output).toBe(200)
    expect(blocks[1]?.startHour).toBe('2026-08-11T14')
  })

  it('emits a gap block for a silence of a full window', () => {
    const state = stateWith({ '2026-08-11T09': 100, '2026-08-11T20': 100 })
    const blocks = identifyBlocks(state, { now: at('2026-08-12T09') })
    const gaps = blocks.filter((block) => block.isGap)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.totals.output).toBe(0)
  })

  it('marks the block containing recent activity as active, and no other', () => {
    const state = stateWith(
      { '2026-08-11T09': 100, '2026-08-11T20': 100 },
      at('2026-08-11T20', 30).toISOString(),
    )
    const blocks = identifyBlocks(state, { now: at('2026-08-11T21') })
    expect(blocks.filter((block) => block.isActive)).toHaveLength(1)
    expect(activeBlock(blocks)?.startHour).toBe('2026-08-11T20')
  })

  it('does not mark a block active once the window has passed', () => {
    const state = stateWith({ '2026-08-11T09': 100 }, at('2026-08-11T09', 5).toISOString())
    const blocks = identifyBlocks(state, { now: at('2026-08-11T23') })
    expect(activeBlock(blocks)).toBeNull()
  })
})

describe('lastActivity', () => {
  it('prefers the recorded timestamp', () => {
    const state = stateWith({ '2026-08-11T09': 1 }, '2026-08-11T09:42:00.000Z')
    expect(lastActivity(state)?.toISOString()).toBe('2026-08-11T09:42:00.000Z')
  })

  it('falls back to the newest hour bucket after a rebuild loses the timestamp', () => {
    const state = stateWith({ '2026-08-11T09': 1, '2026-08-11T11': 1 })
    expect(lastActivity(state)?.getTime()).toBe(at('2026-08-11T11').getTime())
  })
})

describe('burn rate and projection', () => {
  it('measures tokens per minute, and excludes cache in the second figure', () => {
    const state = emptyState()
    state.hourly['2026-08-11T09'] = {
      'claude-code/claude-opus-5': {
        input: 100,
        output: 500,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 5400,
        messages: 3,
      },
    }
    state.lastActivityAt = at('2026-08-11T10').toISOString()
    const blocks = identifyBlocks(state, { now: at('2026-08-11T10') })
    const rate = burnRate(blocks[0]!, lastActivity(state))
    expect(rate?.tokensPerMinute).toBeCloseTo(100, 5)
    expect(rate?.tokensPerMinuteExcludingCache).toBeCloseTo(10, 5)
  })

  it('refuses to extrapolate from a block only minutes old', () => {
    const state = stateWith({ '2026-08-11T09': 500 }, at('2026-08-11T09', 4).toISOString())
    const blocks = identifyBlocks(state, { now: at('2026-08-11T09', 4) })
    expect(burnRate(blocks[0]!, lastActivity(state))).toBeNull()
    expect(project(blocks[0]!, null, at('2026-08-11T09', 4))).toBeNull()
  })

  it('projects the rest of the window at the current rate', () => {
    const state = stateWith({ '2026-08-11T09': 600 }, at('2026-08-11T10').toISOString())
    const blocks = identifyBlocks(state, { now: at('2026-08-11T10') })
    const rate = burnRate(blocks[0]!, lastActivity(state))
    const projection = project(blocks[0]!, rate, at('2026-08-11T10'))
    expect(projection?.remainingMinutes).toBe(240)
    // 600 tokens over 60 minutes, carried across the remaining four hours.
    expect(projection?.totalTokens).toBe(3000)
  })
})

describe('block length', () => {
  it('is overridable, because five hours is a product decision and not a law', () => {
    const state = stateWith({ '2026-08-11T09': 100, '2026-08-11T12': 100 })
    expect(identifyBlocks(state, { now: at('2026-08-12T09') })).toHaveLength(1)
    const shorter = identifyBlocks(state, { now: at('2026-08-12T09'), blockHours: 2 })
    expect(shorter.filter((block) => !block.isGap)).toHaveLength(2)
  })
})

describe('block table', () => {
  it('(bug) emits a cell for every column, including input and output', () => {
    // The header gained a column while the row did not, so every value after it shifted one place
    // left: the message count printed under In+out and the cost printed under Msgs.
    const state = stateWith({ '2026-08-11T09': 100 })
    const rendered = renderBlocks(identifyBlocks(state, { now: at('2026-08-12T09') }))
    // Line 0 is the title, 1 the header, 2 the rule, 3 the first row.
    const [, header, , row] = rendered.split('\n')
    expect(header?.trim().split(/\s{2,}/)).toHaveLength(6)
    expect(row?.trim().split(/\s{2,}/)).toHaveLength(6)
  })
})
