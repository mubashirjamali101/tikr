import { runApp } from '../tui/app.js'
import { isInteractive } from '../tui/screen.js'
import { type Args, flagInt } from '../util/args.js'
import { runStats } from './stats.js'

/**
 * The interactive view.
 *
 * Falls back to the plain report when there is no terminal on both ends - piping `tikr`
 * into a file or another program should produce text, not escape sequences, and raw-mode input is
 * impossible without a TTY on stdin.
 */
export function runUi(args: Args): Promise<number> | number {
  if (!isInteractive()) {
    return runStats(args)
  }
  return runApp(flagInt(args, 'days', 30, 0))
}
