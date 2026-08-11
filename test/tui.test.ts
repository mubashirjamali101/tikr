import { describe, expect, it } from 'vitest'
import { grandTotal, nonCacheTotal } from '../src/core/types.js'
import { emptyState, emptyTotals } from '../src/core/types.js'
import type { Totals } from '../src/core/types.js'
import { blockView } from '../src/tui/block.js'
import { decodeKey, isChar } from '../src/tui/keys.js'
import { snapshot } from '../src/tui/model.js'
import { TABS, type ViewState, renderFrame, rowCount } from '../src/tui/render.js'
import { nextSort, sortForDays, sortRows } from '../src/tui/sort.js'
import { detailTable, shareRows } from '../src/tui/tables.js'
import { truncate, visibleLength } from '../src/tui/theme.js'
import { bar, sparkline } from '../src/tui/widgets.js'

function totals(over: Partial<Totals> = {}): Totals {
  return {
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    messages: 1,
    ...over,
  }
}

function stateWithUsage() {
  const state = emptyState()
  state.daily['2026-08-10'] = {
    'claude-code/claude-opus-5': totals({ output: 100 }),
    'codex/gpt-5.5': totals({ output: 50 }),
  }
  state.daily['2026-08-11'] = {
    'claude-code/claude-opus-5': totals({ output: 300 }),
    'copilot/gpt-5.4': totals({ output: 25 }),
  }
  state.projects.app = { 'claude-code/claude-opus-5': totals({ output: 400 }) }
  return state
}

const view: ViewState = {
  tab: 'overview',
  selected: 0,
  windowDays: 30,
  scanning: false,
  serviceRunning: true,
  lastUpdate: new Date('2026-08-11T12:00:00Z'),
  help: false,
  sort: 'tokens',
}

const size = { columns: 120, rows: 30 }

describe('key decoding', () => {
  it('decodes arrows from their escape sequences', () => {
    expect(decodeKey(Buffer.from('\x1b[A'))).toBe('up')
    expect(decodeKey(Buffer.from('\x1b[B'))).toBe('down')
    expect(decodeKey(Buffer.from('\x1bOB'))).toBe('down')
  })

  it('treats Ctrl-C as quit, since raw mode suppresses SIGINT', () => {
    expect(decodeKey(Buffer.from('\x03'))).toBe('quit')
    expect(decodeKey(Buffer.from('\x04'))).toBe('quit')
  })

  it('(bug) drops an unrecognised escape sequence whole', () => {
    // Returning the bracket and letter as characters made an unbound arrow variant act as if the
    // user had typed those letters, triggering unrelated bindings.
    expect(decodeKey(Buffer.from('\x1b[99;9R'))).toBeNull()
  })

  it('passes plain characters through', () => {
    const key = decodeKey(Buffer.from('q'))
    expect(isChar(key!, 'q')).toBe(true)
  })
})

describe('widgets', () => {
  it('fills a bar in proportion and pads to width', () => {
    expect(visibleLength(bar(0.5, 10))).toBe(10)
    expect(bar(1, 4)).toBe('████')
    expect(bar(0, 4).trim()).toBe('')
  })

  it('clamps a nonsense fraction rather than overflowing the row', () => {
    expect(visibleLength(bar(5, 6))).toBe(6)
    expect(visibleLength(bar(Number.NaN, 6))).toBe(6)
  })

  it('scales a sparkline to its own maximum', () => {
    expect(sparkline([1, 2, 3, 4], 4)).toBe('▂▄▆█')
    expect(sparkline([], 4)).toBe('')
  })
})

describe('truncation keeps colour codes intact', () => {
  it('(bug) never cuts an escape sequence in half', () => {
    // Slicing a coloured string by raw index can leave a partial escape, which corrupts every
    // following cell on the row.
    const coloured = `\x1b[36m${'x'.repeat(50)}\x1b[0m`
    const cut = truncate(coloured, 10)
    expect(visibleLength(cut)).toBeLessThanOrEqual(10)
    expect(cut.endsWith('…')).toBe(true)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting a truncated escape is the point.
    expect(/\x1b\[[0-9;]*$/.test(cut)).toBe(false)
  })
})

describe('snapshot', () => {
  it('sums every tool into one total', () => {
    const snap = snapshot(stateWithUsage(), 30)
    expect(snap.total.output).toBe(475)
    expect(snap.byProvider.map((r) => r.key).sort()).toEqual(['claude-code', 'codex', 'copilot'])
  })

  it('orders tools by usage, heaviest first', () => {
    const snap = snapshot(stateWithUsage(), 30)
    expect(snap.byProvider[0]?.key).toBe('claude-code')
  })

  it('builds a per-tool daily trend aligned to the window', () => {
    const snap = snapshot(stateWithUsage(), 30)
    const claude = snap.byProvider.find((r) => r.key === 'claude-code')
    // grandTotal counts tokens, not messages.
    expect(claude?.trend).toEqual([100, 300])
  })

  it('honours the window, and 0 means all history', () => {
    expect(snapshot(stateWithUsage(), 1).days).toEqual(['2026-08-11'])
    expect(snapshot(stateWithUsage(), 0).days).toHaveLength(2)
  })

  it('reports nothing rather than throwing on an empty record', () => {
    const snap = snapshot(emptyState(), 30)
    expect(snap.total.output).toBe(0)
    expect(snap.byProvider).toEqual([])
    expect(snap.from).toBeNull()
  })
})

describe('frame rendering', () => {
  it('fills the terminal height exactly, so the status bar pins to the bottom', () => {
    const frame = renderFrame(snapshot(stateWithUsage(), 30), view, size)
    expect(frame.length).toBe(size.rows)
  })

  it('never emits a row wider than the terminal', () => {
    for (const tab of TABS) {
      const frame = renderFrame(snapshot(stateWithUsage(), 30), { ...view, tab }, size)
      for (const line of frame) {
        expect(visibleLength(line)).toBeLessThanOrEqual(size.columns)
      }
    }
  })

  it('(bug) keeps the status bar visible on a short terminal', () => {
    // The body used to be padded but never truncated, so on a short terminal it pushed the footer
    // past the last row and the status line vanished.
    const narrow = { columns: 40, rows: 12 }
    const frame = renderFrame(snapshot(stateWithUsage(), 30), view, narrow)
    expect(frame.length).toBe(narrow.rows)
    for (const line of frame) expect(visibleLength(line)).toBeLessThanOrEqual(narrow.columns)
    // The last line is always the status bar.
    expect(frame[frame.length - 1]).toContain('live')
  })

  it('scrolls a long list to keep the selection on screen', () => {
    const state = emptyState()
    const day: Record<string, Totals> = {}
    for (let i = 0; i < 60; i += 1) day[`codex/model-${i}`] = totals({ output: 60 - i })
    state.daily['2026-08-11'] = day

    const short = { columns: 100, rows: 14 }
    const frame = renderFrame(
      snapshot(state, 30),
      { ...view, tab: 'models', selected: 55 },
      short,
    ).join('\n')
    expect(frame).toContain('model-55')
    expect(frame.split('\n').length).toBe(short.rows)
  })

  it('renders every tab without data', () => {
    for (const tab of TABS) {
      const frame = renderFrame(snapshot(emptyState(), 30), { ...view, tab }, size)
      expect(frame.length).toBe(size.rows)
    }
  })

  it('shows the summed total on the overview', () => {
    const plain = renderFrame(snapshot(stateWithUsage(), 30), view, size)
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour for assertions.
      .replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain).toContain('total tokens across all tools')
  })

  it('shows help when toggled', () => {
    const plain = renderFrame(snapshot(stateWithUsage(), 30), { ...view, help: true }, size).join(
      '\n',
    )
    expect(plain).toContain('Keys')
  })
})

describe('row counts drive selection bounds', () => {
  it('matches the rows each tab renders', () => {
    const snap = snapshot(stateWithUsage(), 30)
    expect(rowCount(snap, 'overview')).toBe(3)
    expect(rowCount(snap, 'models')).toBe(3)
    expect(rowCount(snap, 'days')).toBe(2)
    expect(rowCount(snap, 'projects')).toBe(1)
  })
})

describe('model rows stay distinguishable', () => {
  it('(bug) shows the tool when two tools use the same model', () => {
    // Claude Code and Copilot both report `claude-opus-5`. Without a tool column the two rows are
    // identical apart from colour, which conveys nothing when colour is disabled.
    const state = emptyState()
    state.daily['2026-08-11'] = {
      'claude-code/claude-opus-5': totals({ output: 100 }),
      'copilot/claude-opus-5': totals({ output: 50 }),
    }
    const plain = renderFrame(snapshot(state, 30), { ...view, tab: 'models' }, size)
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour for assertions.
      .replace(/\x1b\[[0-9;]*m/g, '')

    expect(plain).toContain('claude-code')
    expect(plain).toContain('copilot')
  })
})

describe('sorting', () => {
  const rows = [
    {
      key: 'a',
      label: 'zeta',
      provider: 'x',
      providers: ['x'],
      totals: totals({ output: 10, messages: 9 }),
      cost: 1,
      trend: [],
    },
    {
      key: 'b',
      label: 'alpha',
      provider: 'x',
      providers: ['x'],
      totals: totals({ output: 50, messages: 1 }),
      cost: 9,
      trend: [],
    },
    {
      key: 'c',
      label: 'mid',
      provider: 'x',
      providers: ['x'],
      totals: totals({ output: 30, messages: 5 }),
      cost: 5,
      trend: [],
    },
  ]

  it('cycles through every mode and back', () => {
    expect(nextSort('tokens')).toBe('cost')
    expect(nextSort('cost')).toBe('messages')
    expect(nextSort('messages')).toBe('name')
    expect(nextSort('name')).toBe('tokens')
  })

  it('ranks numeric sorts largest first', () => {
    expect(sortRows(rows, 'tokens').map((r) => r.key)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'cost').map((r) => r.key)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'messages').map((r) => r.key)).toEqual(['a', 'c', 'b'])
  })

  it('sorts by name ascending, since that is for finding not ranking', () => {
    expect(sortRows(rows, 'name').map((r) => r.label)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('never mutates the rows it was given', () => {
    const before = rows.map((r) => r.key)
    sortRows(rows, 'cost')
    expect(rows.map((r) => r.key)).toEqual(before)
  })

  it('(bug) keeps the days view in date order under a size sort', () => {
    // Days are a timeline. Re-ranking them by size destroys the only thing that view is for.
    const days = sortForDays(rows, 'cost')
    expect(days.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(sortForDays(rows, 'name').map((r) => r.label)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('shows the active sort in the status bar', () => {
    const frame = renderFrame(snapshot(stateWithUsage(), 30), { ...view, sort: 'cost' }, size)
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour for assertions.
      .replace(/\x1b\[[0-9;]*m/g, '')
    expect(frame).toContain('by cost')
  })

  it('actually reorders the rendered rows', () => {
    const state = emptyState()
    state.daily['2026-08-11'] = {
      'codex/aaa': totals({ output: 10, messages: 100 }),
      'codex/zzz': totals({ output: 900, messages: 1 }),
    }
    const plain = (sort: 'tokens' | 'messages') =>
      renderFrame(snapshot(state, 30), { ...view, tab: 'models', sort }, size)
        .join('\n')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour for assertions.
        .replace(/\x1b\[[0-9;]*m/g, '')

    expect(plain('tokens').indexOf('zzz')).toBeLessThan(plain('tokens').indexOf('aaa'))
    expect(plain('messages').indexOf('aaa')).toBeLessThan(plain('messages').indexOf('zzz'))
  })
})

describe('project attribution', () => {
  function multiToolState() {
    const state = emptyState()
    state.projects.shared = {
      'claude-code/claude-opus-5': totals({ output: 100 }),
      'codex/gpt-5.5': totals({ output: 900 }),
    }
    state.projects.solo = { 'claude-code/claude-opus-5': totals({ output: 10 }) }
    return state
  }

  it('(bug) names the dominant tool, not whichever model was enumerated first', () => {
    // The old code read the provider off Object.keys(...)[0], which is arbitrary and could differ
    // between runs for the same data.
    const snap = snapshot(multiToolState(), 30)
    const shared = snap.byProject.find((r) => r.key === 'shared')
    expect(shared?.provider).toBe('codex')
  })

  it('lists every tool that touched a project, heaviest first', () => {
    const snap = snapshot(multiToolState(), 30)
    expect(snap.byProject.find((r) => r.key === 'shared')?.providers).toEqual([
      'codex',
      'claude-code',
    ])
    expect(snap.byProject.find((r) => r.key === 'solo')?.providers).toEqual(['claude-code'])
  })

  it('shows the contributing tools in the projects view', () => {
    const plain = renderFrame(snapshot(multiToolState(), 30), { ...view, tab: 'projects' }, size)
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour for assertions.
      .replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain).toContain('Tools')
    expect(plain).toMatch(/codex, claude-code|claude-code, codex/)
  })
})

describe('input and output column', () => {
  const totals = {
    input: 1_000,
    output: 9_000,
    cacheWrite5m: 100_000,
    cacheWrite1h: 0,
    cacheRead: 5_000_000,
    messages: 3,
  }

  it('sums input and output only', () => {
    expect(nonCacheTotal(totals)).toBe(10_000)
    expect(grandTotal(totals)).toBe(5_110_000)
  })

  const row = {
    key: 'k',
    label: 'claude-opus-5',
    provider: 'claude-code',
    providers: ['claude-code'],
    totals,
    cost: 5,
    nonCacheCost: 1,
    trend: [1, 2, 3],
  }

  it('appears beside the total on the model, day and project tabs', () => {
    for (const lines of [
      detailTable([row], 200, 0, 'Model', 'tool'),
      detailTable([row], 200, 0, 'Day'),
      detailTable([row], 200, 0, 'Project', 'tools'),
    ]) {
      expect(lines[0]).toContain('In+out')
      // 10K input+output next to 5.11M total, so the two are visibly different numbers.
      expect(lines[1]).toContain('10.0K')
      expect(lines[1]).toContain('5.11M')
    }
  })

  it('is the whole difference between the two overview tables', () => {
    const all = shareRows([row], 200, 0, true, 'all')
    const pure = shareRows([row], 200, 0, true, 'nonCache')
    // Same columns, same row, different measure - and the cost follows the measure so the second
    // table is not read as costing the same for a tenth of the tokens.
    expect(all[0]).toBe(pure[0])
    expect(all[1]).toContain('5.11M')
    expect(all[1]).toContain('$5.00')
    expect(pure[1]).toContain('10.0K')
    expect(pure[1]).toContain('$1.00')
  })

  it('is dropped before the total when the terminal is narrow', () => {
    const narrow = detailTable([{ ...row, label: 'm', providers: [] }], 60, 0, 'Model')
    expect(narrow[0]).toContain('Total')
    expect(narrow[0]).not.toContain('In+out')
  })
})

describe('block ceiling on the compact line', () => {
  function stateWithBlocks(count: number): ReturnType<typeof emptyState> {
    const state = emptyState()
    const now = new Date()
    for (let index = 0; index < count; index += 1) {
      const day = new Date(now.getTime() - (index + 1) * 86_400_000)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}T09`
      state.hourly[key] = {
        'claude-code/claude-opus-5': { ...emptyTotals(), output: 1_000, messages: 1 },
      }
    }
    // An active block, far larger than any of the completed ones above.
    const hour = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}`
    state.hourly[hour] = {
      'claude-code/claude-opus-5': { ...emptyTotals(), output: 5_000_000, messages: 50 },
    }
    state.lastActivityAt = now.toISOString()
    return state
  }

  it('(bug) hides the percentage when the baseline is a handful of tiny blocks', () => {
    // A record an hour old made a normal session read as "1269% of usual", which looks like an
    // emergency and is really just an empty history.
    expect(blockView(stateWithBlocks(2))?.percentOfCeiling).toBeNull()
  })

  it('shows it once there are enough completed blocks to mean something', () => {
    const view = blockView(stateWithBlocks(6))
    expect(view?.percentOfCeiling).toBeGreaterThan(0)
    expect(view?.ceilingBasis).toBe('observed')
  })
})
