import { grandTotal, nonCacheTotal } from '../core/types.js'
import { count, duration, tokens, usd } from '../report/format.js'
import type { Snapshot } from './model.js'
import { SORT_LABEL, type SortKey, sortForDays, sortRows } from './sort.js'
import { detailTable, shareRows } from './tables.js'
import { bold, cyan, dim, grey, inverse, padEnd, truncate } from './theme.js'
import { bigNumber, centre } from './widgets.js'

export type Tab = 'overview' | 'models' | 'days' | 'projects'
export const TABS: Tab[] = ['overview', 'models', 'days', 'projects']

export interface ViewState {
  tab: Tab
  selected: number
  windowDays: number
  scanning: boolean
  serviceRunning: boolean
  lastUpdate: Date
  help: boolean
  sort: SortKey
}

/** Headline: every tool, added together, as one number nobody has to compute. */
function hero(snap: Snapshot, width: number): string[] {
  const total = grandTotal(snap.total)
  const glyphs = bigNumber(tokens(total)).map((line) => cyan(centre(line, width)))
  return [
    '',
    ...glyphs,
    centre(
      `${dim('total tokens across all tools')}   ${bold(usd(snap.totalCost))} ${dim('est.')}   ${dim(`${count(snap.total.messages)} messages`)}`,
      width,
    ),
    // The headline counts cache, which is most of it. Naming the input-and-output figure next to it
    // keeps the big number from being read as work done.
    centre(
      dim(`${tokens(nonCacheTotal(snap.total))} of it input and output, the rest cache`),
      width,
    ),
    '',
  ]
}

/**
 * The active block, as one line.
 *
 * Deliberately not a panel: it is a status, and a status that takes six rows pushes the data it is
 * meant to contextualise off the screen.
 */
function blockLine(snap: Snapshot, width: number): string[] {
  const block = snap.block
  if (block === null) return []
  const parts = [
    `${bold('current block')} ${tokens(block.tokens)}`,
    usd(block.costUsd),
    `${duration(block.remainingMs)} left`,
  ]
  if (block.tokensPerMinute !== null) parts.push(`${tokens(block.tokensPerMinute)}/min`)
  if (block.percentOfCeiling !== null) {
    const of = block.ceilingBasis === 'limited' ? 'of your limit' : 'of your largest'
    parts.push(`${block.percentOfCeiling}% ${of}`)
  }
  return [centre(parts.join(dim('  ·  ')), width), '']
}

function tabBar(active: Tab, width: number): string {
  const labels = TABS.map((tab) => {
    const text = ` ${tab} `
    return tab === active ? inverse(bold(text)) : dim(text)
  })
  return padEnd(labels.join(' '), width)
}

/**
 * Bottom bar, shedding detail as the terminal narrows.
 *
 * The service indicator is the one thing that always survives: knowing whether the numbers are
 * live matters more than knowing the date range, which the views themselves imply.
 */
function statusBar(view: ViewState, snap: Snapshot, width: number): string {
  const service = view.serviceRunning ? '● live' : '○ stopped'
  const window = view.windowDays <= 0 ? 'all time' : `${view.windowDays}d`
  const order = `by ${SORT_LABEL[view.sort]}`
  const range = snap.from === null ? 'no usage yet' : `${snap.from} to ${snap.to}`
  const right = view.scanning ? 'scanning…' : `updated ${view.lastUpdate.toLocaleTimeString()}`

  for (const left of [
    `${service}  ${window}  ${order}  ${range}`,
    `${service}  ${window}  ${order}`,
    `${service}  ${order}`,
    service,
  ]) {
    const gap = width - left.length - right.length
    if (gap >= 2) return dim(left + ' '.repeat(gap) + right)
  }
  return dim(truncate(`${service}  ${order}`, width))
}

const HELP = [
  '',
  bold('  Keys'),
  '',
  '  tab / shift-tab      switch view          1-4    jump to view',
  '  up down / j k        move selection       g / G  first / last',
  '  d                    cycle window: 7d, 30d, 90d, all',
  '  s                    cycle sort: tokens, cost, messages, name',
  '  r                    rescan now',
  '  ?                    toggle this help     q      quit',
  '',
  bold('  What you are looking at'),
  '',
  '  Every tracked tool is read from its own local session files and summed here.',
  '  Cost is an estimate at published list rates, not a bill.',
  '',
]

export function renderFrame(
  snap: Snapshot,
  view: ViewState,
  size: { columns: number; rows: number },
): string[] {
  const width = size.columns
  const header = [
    bold(cyan(padEnd('  tikr', width - 10))),
    tabBar(view.tab, width),
    grey('─'.repeat(width)),
  ]
  const footer = [grey('─'.repeat(width)), statusBar(view, snap, width)]

  const body: string[] = []
  if (view.help) {
    body.push(...HELP)
  } else if (view.tab === 'overview') {
    // The hero is the first thing to go on a short terminal: the table below it carries the same
    // information and more.
    if (size.rows >= 18) body.push(...hero(snap, width))
    body.push(...blockLine(snap, width))
    if (snap.byProvider.length === 0) {
      body.push(dim('  No usage recorded yet. Start the service with `tikr start`.'))
    } else {
      // The same table twice, differing only in whether cache counts. Cache is the bulk of the
      // first one and none of the second, and which tool leads can differ between them, so both
      // are shown rather than one being chosen on the reader's behalf.
      const ordered = sortRows(snap.byProvider, view.sort)
      body.push(dim('  every token, cache included'))
      body.push(...shareRows(ordered, width, view.selected, true, 'all'))
      body.push('')
      body.push(dim('  input and output only'))
      body.push(...shareRows(ordered, width, view.selected, true, 'nonCache'))
    }
    if (snap.idle.length > 0) {
      body.push('', dim(`  installed, no usage recorded yet: ${snap.idle.join(', ')}`))
    }
  } else if (view.tab === 'models') {
    body.push(
      ...detailTable(sortRows(snap.byModel, view.sort), width, view.selected, 'Model', 'tool'),
    )
  } else if (view.tab === 'days') {
    body.push(...detailTable(sortForDays(snap.byDay, view.sort), width, view.selected, 'Day'))
  } else {
    body.push(
      ...detailTable(sortRows(snap.byProject, view.sort), width, view.selected, 'Project', 'tools'),
    )
  }

  // Truncate the body rather than letting it push the status bar off-screen. Scrolling the
  // selection into view keeps the highlighted row visible however long the list is.
  const budget = Math.max(1, size.rows - header.length - footer.length)
  const visible = scrollTo(body, budget, view.selected)

  // Final guarantee: nothing leaves this function wider than the terminal. A single overflowing
  // line wraps and shifts every row below it, so the invariant is enforced here rather than
  // trusted to each view.
  return [...header, ...visible, ...Array(budget - visible.length).fill(''), ...footer].map(
    (line) => truncate(line, width),
  )
}

/**
 * Window a list around the selected row.
 *
 * `offset` accounts for the header row that every table emits before its data, so the selection
 * index lines up with the right entry.
 */
function scrollTo(body: string[], budget: number, selected: number): string[] {
  if (body.length <= budget) return body
  const headerOffset = body.length > 0 ? 1 : 0
  const target = selected + headerOffset
  const start = Math.max(0, Math.min(body.length - budget, target - Math.floor(budget / 2)))
  return body.slice(start, start + budget)
}

export function rowCount(snap: Snapshot, tab: Tab): number {
  if (tab === 'overview') return snap.byProvider.length
  if (tab === 'models') return snap.byModel.length
  if (tab === 'days') return snap.byDay.length
  return snap.byProject.length
}
