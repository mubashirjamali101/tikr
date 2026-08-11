import { dim, padEnd, padStart, visibleLength } from './theme.js'

const BLOCKS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Proportional bar with sub-cell precision, so small shares stay visible. */
export function bar(fraction: number, width: number): string {
  if (width <= 0) return ''
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const exact = clamped * width
  const full = Math.floor(exact)
  const remainder = exact - full
  let out = '█'.repeat(full)
  if (full < width && remainder > 0.05) {
    out += BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, Math.floor(remainder * 8) - 1))] ?? ''
  }
  return padEnd(out, width)
}

/**
 * Sparkline over a series.
 *
 * Scaled to the maximum in the window rather than to an absolute, because the shape of recent
 * activity is the useful signal; the magnitude is already given as a number beside it.
 */
export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return ''
  const window = values.slice(-width)
  const max = Math.max(...window)
  // Uncoloured: the caller owns the colour, and wrapping here produced nested escape sequences.
  if (max <= 0) return '▁'.repeat(window.length)
  return window
    .map((value) => {
      if (value <= 0) return ' '
      const index = Math.min(SPARKS.length - 1, Math.floor((value / max) * (SPARKS.length - 1)))
      return SPARKS[index] ?? '▁'
    })
    .join('')
}

export interface Column {
  header: string
  width: number
  align?: 'left' | 'right'
  /**
   * Drop order when the terminal is too narrow. Higher goes first; a column without one is
   * essential and is never dropped.
   */
  drop?: number
}

const GAP = 2

function totalWidth(columns: Column[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0) + GAP * (columns.length - 1)
}

/**
 * Drop optional columns, widest-priority first, until the row fits.
 *
 * A table that overflows wraps in the terminal and destroys the whole layout, so narrowing has to
 * shed information deliberately rather than let the shell do it arbitrarily. The last resort is
 * shrinking the first column, which is the label.
 */
export function fitColumns(columns: Column[], width: number): Column[] {
  let kept = [...columns]
  while (totalWidth(kept) > width && kept.some((column) => column.drop !== undefined)) {
    let worst = -1
    let worstIndex = -1
    kept.forEach((column, index) => {
      if (column.drop !== undefined && column.drop > worst) {
        worst = column.drop
        worstIndex = index
      }
    })
    if (worstIndex === -1) break
    kept = kept.filter((_, index) => index !== worstIndex)
  }

  const overflow = totalWidth(kept) - width
  const first = kept[0]
  if (overflow > 0 && first !== undefined) {
    kept[0] = { ...first, width: Math.max(6, first.width - overflow) }
  }
  return kept
}

export function headerRow(columns: Column[]): string {
  return dim(
    columns
      .map((column) =>
        column.align === 'right'
          ? padStart(column.header, column.width)
          : padEnd(column.header, column.width),
      )
      .join('  '),
  )
}

export function row(columns: Column[], cells: string[]): string {
  return columns
    .map((column, index) => {
      const cell = cells[index] ?? ''
      return column.align === 'right' ? padStart(cell, column.width) : padEnd(cell, column.width)
    })
    .join('  ')
}

/** Centre text within a width, ignoring colour codes. */
export function centre(text: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(text))
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

const DIGITS: Record<string, string[]> = {
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': [' ▄█', '  █', '  ▀'],
  '2': ['█▀█', ' ▄▀', '▀▀▀'],
  '3': ['█▀█', ' ▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['█▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  '.': ['   ', '   ', ' ▀ '],
  ',': ['   ', '   ', ' ▄ '],
  B: ['█▀▄', '█▀▄', '▀▀ '],
  M: ['█▄█', '█ █', '▀ ▀'],
  K: ['█ █', '█▀▄', '▀ ▀'],
  ' ': ['  ', '  ', '  '],
}

/** Render a short string as three-line block digits, for the headline total. */
export function bigNumber(text: string): string[] {
  const rows = ['', '', '']
  for (const character of text) {
    const glyph = DIGITS[character] ?? DIGITS[' ']!
    for (let line = 0; line < 3; line += 1) rows[line] += `${glyph[line]} `
  }
  return rows
}
