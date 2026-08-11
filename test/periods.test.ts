import { describe, expect, it } from 'vitest'
import { lastPeriodsSince, monthStart, periodKey, weekStart } from '../src/core/periods.js'
import { emptyState, emptyTotals } from '../src/core/types.js'
import { toCsv } from '../src/report/csv.js'
import { daysWithin } from '../src/report/groups.js'
import { prettyProject } from '../src/report/project.js'

describe('weekStart', () => {
  it('starts on the configured day', () => {
    // 2026-07-29 is a Wednesday.
    expect(weekStart('2026-07-29', 'monday')).toBe('2026-07-27')
    expect(weekStart('2026-07-29', 'sunday')).toBe('2026-07-26')
  })

  it('crosses a month boundary backwards', () => {
    expect(weekStart('2026-08-01', 'monday')).toBe('2026-07-27')
  })

  it('rejects a value that is not a date', () => {
    expect(weekStart('not-a-date')).toBeNull()
  })
})

describe('lastPeriodsSince', () => {
  it('counts days inclusively, across a month boundary', () => {
    expect(lastPeriodsSince('day', 3, '2026-08-01')).toBe('2026-07-30')
  })

  it('counts whole weeks back from the current one', () => {
    expect(lastPeriodsSince('week', 2, '2026-07-29', 'monday')).toBe('2026-07-20')
  })

  it('starts months on the first and wraps the year', () => {
    expect(lastPeriodsSince('month', 1, '2026-07-27')).toBe('2026-07-01')
    expect(lastPeriodsSince('month', 3, '2026-01-15')).toBe('2025-11-01')
  })

  it('treats a count of zero as the current period', () => {
    expect(lastPeriodsSince('day', 0, '2026-07-27')).toBe('2026-07-27')
  })
})

describe('periodKey', () => {
  it('buckets a day into its week and month', () => {
    expect(periodKey('2026-08-11', 'day')).toBe('2026-08-11')
    expect(periodKey('2026-08-11', 'week')).toBe('2026-08-10')
    expect(periodKey('2026-08-11', 'month')).toBe('2026-08-01')
    expect(monthStart('2026-08-11')).toBe('2026-08-01')
  })
})

describe('prettyProject', () => {
  it('drops the home prefix and the account name, keeping hyphens in the name', () => {
    expect(prettyProject('-Users-me-code-my-app')).toBe('my-app')
    expect(prettyProject('-home-me-code-my-app')).toBe('my-app')
  })

  it('handles a Windows path', () => {
    expect(prettyProject('C:\\Users\\me\\code\\my-app')).toBe('my-app')
  })

  it('honours an alias, by encoded key or by shortened name', () => {
    expect(prettyProject('-Users-me-code-my-app', { '-Users-me-code-my-app': 'cc' })).toBe('cc')
    expect(prettyProject('-Users-me-code-my-app', { 'my-app': 'the app' })).toBe('the app')
  })

  it('keeps something printable for unusual keys', () => {
    expect(prettyProject('')).toBe('unknown project')
    expect(prettyProject('unknown')).toBe('unknown project')
    expect(prettyProject('-Users-me')).toBe('me')
    expect(prettyProject('codex')).toBe('codex')
  })
})

describe('toCsv', () => {
  it('emits a header and one row per model, quoting what needs it', () => {
    const csv = toCsv([
      [
        'my, project',
        { 'claude-code/claude-opus-5': { ...emptyTotals(), input: 10, messages: 1 } },
      ],
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toContain('bucket,model,input')
    expect(lines[1]).toContain('"my, project"')
  })

  it('adds a total row only when a bucket holds several models', () => {
    const single = toCsv([['a', { 'claude-code/claude-opus-5': emptyTotals() }]])
    expect(single.split('\n')).toHaveLength(2)
    const multi = toCsv([
      [
        'a',
        {
          'claude-code/claude-opus-5': emptyTotals(),
          'claude-code/claude-sonnet-5': emptyTotals(),
        },
      ],
    ])
    expect(multi.split('\n')).toHaveLength(4)
  })
})

describe('daysWithin', () => {
  const state = emptyState()
  for (const day of ['2026-08-09', '2026-08-10', '2026-08-11']) {
    state.daily[day] = { 'claude-code/claude-opus-5': emptyTotals() }
  }

  it('treats both bounds as inclusive', () => {
    expect(daysWithin(state, '2026-08-10', '2026-08-10')).toEqual(['2026-08-10'])
  })

  it('leaves an omitted bound open', () => {
    expect(daysWithin(state, null, '2026-08-10')).toEqual(['2026-08-09', '2026-08-10'])
    expect(daysWithin(state, '2026-08-10', null)).toEqual(['2026-08-10', '2026-08-11'])
    expect(daysWithin(state, null, null)).toHaveLength(3)
  })
})

describe('empty window wording', () => {
  it('(bug) distinguishes an empty window from an empty record', () => {
    // A tool used for a fortnight and then left alone falls out of the 30-day default. Saying "no
    // usage recorded yet" there tells the user their history is gone when it is not.
    const state = emptyState()
    state.daily['2025-01-01'] = { 'claude-code/claude-opus-5': emptyTotals() }
    expect(daysWithin(state, '2026-08-01')).toEqual([])
    expect(Object.keys(state.daily)).toHaveLength(1)
  })
})
