/** Compact token count: 1_234_567 -> "1.23M". Keeps columns narrow without losing magnitude. */
export function tokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}

export function usd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

export function count(value: number): string {
  return value.toLocaleString('en-US')
}

export interface Column {
  header: string
  align: 'left' | 'right'
}

/**
 * Render a fixed-width table.
 *
 * Numbers are right-aligned so magnitudes line up and a column can be scanned vertically; labels
 * stay left-aligned. Rows shorter than the column list are padded rather than rejected, which keeps
 * separator rows simple to emit.
 */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((column, index) => {
    const cells = rows.map((row) => (row[index] ?? '').length)
    return Math.max(column.header.length, ...cells, 0)
  })

  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width)
      })
      .join('  ')
      .trimEnd()

  const out = [line(columns.map((column) => column.header))]
  out.push(
    widths
      .map((width) => '-'.repeat(width))
      .join('  ')
      .trimEnd(),
  )
  for (const row of rows) {
    out.push(line(columns.map((_, index) => row[index] ?? '')))
  }
  return out.join('\n')
}

/** "3 minutes ago" style relative time, for status output. */
export function since(iso: string | null): string {
  if (iso === null) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

/**
 * Usable terminal width.
 *
 * Falls back to a width that fits the full table when stdout is not a terminal, so piping to a file
 * or a test never silently drops columns.
 */
export function terminalWidth(): number {
  const columns = process.stdout.columns
  return typeof columns === 'number' && columns > 20 ? columns : 200
}

/** Duration in whole hours and minutes, for block timers. */
export function duration(millis: number): string {
  const total = Math.max(0, Math.round(millis / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** Local clock time, `14:05`. */
export function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
