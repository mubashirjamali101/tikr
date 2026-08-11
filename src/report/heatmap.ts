import { hourToDate } from '../core/blocks.js'
import { type State, grandTotal } from '../core/types.js'
import { tokens } from './format.js'
import { indent } from './render.js'

/**
 * When the tokens actually go, as hour against weekday.
 *
 * A table of days answers how much; this answers when, which is the question that changes how
 * someone works. It exists only because usage is now bucketed by hour.
 *
 * Block characters are typography, not icons: they carry the magnitude, and the legend gives the
 * scale in tokens so the picture is never the only source of truth.
 */

const SHADES = [' ', '░', '▒', '▓', '█']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * weekday index (0 = Monday) -> hour -> tokens.
 *
 * `days` restricts it to the report window; without it the picture would quietly cover all history
 * while every other section showed the last 30 days.
 */
export function heatmapData(state: State, days: string[] | null = null): number[][] {
  const within = days === null ? null : new Set(days)
  const grid: number[][] = WEEKDAYS.map(() => new Array<number>(24).fill(0))
  for (const [hour, byModel] of Object.entries(state.hourly)) {
    if (within !== null && !within.has(hour.slice(0, 10))) continue
    const at = hourToDate(hour)
    if (Number.isNaN(at.getTime())) continue
    const weekday = (at.getDay() + 6) % 7
    let total = 0
    for (const totals of Object.values(byModel)) total += grandTotal(totals)
    grid[weekday]![at.getHours()]! += total
  }
  return grid
}

function shade(value: number, peak: number): string {
  if (value <= 0 || peak <= 0) return SHADES[0]!
  const step = Math.ceil((value / peak) * (SHADES.length - 1))
  return SHADES[Math.min(SHADES.length - 1, step)]!
}

export function renderHeatmap(state: State, days: string[] | null = null): string {
  const grid = heatmapData(state, days)
  const peak = Math.max(...grid.flat())
  if (peak <= 0) return 'By hour\n  no usage recorded'

  // One character per hour, so the axis is drawn as two lines: ticks, then the hour under each.
  const ticks = Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? '|' : ' ')).join('')
  const labels = Array.from({ length: 24 }, (_, hour) =>
    hour % 6 === 0 ? String(hour).padEnd(6, ' ') : '',
  ).join('')
  const header = `     ${ticks}\n     ${labels.slice(0, 24)}`
  const rows = grid.map(
    (day, index) => `${WEEKDAYS[index]}  ${day.map((value) => shade(value, peak)).join('')}`,
  )
  const legend = `Each cell is one hour of the week. Darkest is ${tokens(peak)} tokens.`
  return `By hour of week\n${indent([header, ...rows, '', legend].join('\n'))}`
}
