/** Terminal control: alternate screen, raw input, and a guaranteed restore. */

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'
const HOME = '\x1b[H'
const CLEAR_LINE = '\x1b[K'
const CLEAR_BELOW = '\x1b[J'

export interface Size {
  columns: number
  rows: number
}

export function terminalSize(): Size {
  return {
    columns: Math.max(40, process.stdout.columns ?? 80),
    rows: Math.max(10, process.stdout.rows ?? 24),
  }
}

export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}

let restored = false

/**
 * Put the terminal into full-screen mode and register every path back out of it.
 *
 * A TUI that exits without restoring leaves the user with no cursor, no echo, and no working
 * Ctrl-C, which is worse than any bug in the program itself. So the restore is idempotent and is
 * wired to normal exit, both terminating signals, and an uncaught throw.
 */
export function enterScreen(): void {
  restored = false
  process.stdout.write(ALT_ON + CURSOR_HIDE)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  process.on('exit', restoreScreen)
  process.on('SIGINT', exitCleanly)
  process.on('SIGTERM', exitCleanly)
  process.on('uncaughtException', (error) => {
    restoreScreen()
    console.error(error)
    process.exit(1)
  })
}

function exitCleanly(): void {
  restoreScreen()
  process.exit(0)
}

export function restoreScreen(): void {
  if (restored) return
  restored = true
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false)
    } catch {
      // The stream may already be closed during shutdown.
    }
  }
  process.stdin.pause()
  process.stdout.write(CURSOR_SHOW + ALT_OFF)
}

/**
 * Draw a frame.
 *
 * Each line is erased to the end as it is written and the remainder of the screen is cleared once
 * at the bottom, rather than blanking the whole screen first. Clearing first produces a visible
 * flash on every repaint; this way the terminal only ever sees the cells that changed.
 */
export function paint(lines: string[], size: Size): void {
  // Exactly `rows` lines, joined without a trailing newline. A newline after the final row makes
  // the terminal scroll by one, which pushes the top line out of view on every repaint - and
  // slicing a row off to compensate silently drops the status bar instead.
  const visible = lines.slice(0, size.rows)
  const body = visible.map((line) => `${line}${CLEAR_LINE}`).join('\n')
  process.stdout.write(`${HOME}${body}${CLEAR_BELOW}`)
}

export function onResize(handler: () => void): () => void {
  process.stdout.on('resize', handler)
  return () => {
    process.stdout.off('resize', handler)
  }
}
