import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { statePath } from '../core/paths.js'
import { readPid } from '../daemon/lock.js'
import { type Args, flagBool } from '../util/args.js'

/**
 * Delete recorded statistics and start counting again from the current end of every transcript.
 *
 * This destroys data the user cannot get back: transcripts older than the current tail are never
 * re-read, so history is not recoverable by rescanning. It therefore requires an explicit
 * `--yes` rather than an interactive prompt, which keeps it scriptable and impossible to trigger
 * by accident.
 */
export function runReset(args: Args): number {
  if (!flagBool(args, 'yes')) {
    console.error('This permanently deletes all recorded usage statistics.')
    console.error(`It removes ${statePath()}.`)
    console.error('')
    console.error('Past usage is not recoverable: already-ingested transcript bytes are not')
    console.error('re-read, so a later scan starts from the current end of each file.')
    console.error('')
    console.error('Re-run with --yes if that is what you want.')
    return 1
  }

  const pid = readPid()
  if (pid !== null) {
    console.error(`The service is running (pid ${pid}) and would immediately rewrite state.`)
    console.error('Run `tikr stop` first.')
    return 1
  }

  try {
    rmSync(statePath())
    // The backup exists to survive corruption, not to survive a deliberate reset.
    try {
      rmSync(join(dirname(statePath()), 'state.backup.json'))
    } catch {
      // No backup to remove.
    }
    console.log('Deleted all recorded statistics.')
  } catch {
    console.log('No statistics to delete.')
  }
  return 0
}
