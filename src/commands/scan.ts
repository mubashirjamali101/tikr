import { commit } from '../core/commit.js'
import { emptyResult } from '../core/ingest.js'
import { scanAll } from '../core/scan.js'
import { describeReset, loadState, saveState } from '../core/state.js'
import { type Args, flagBool } from '../util/args.js'

/**
 * Run one ingest pass in the foreground.
 *
 * Useful without the service (a cron entry, a CI check, or just impatience), and `--dry-run` is the
 * safe way to try ingest changes against real transcripts: it reports what would be recorded and
 * writes nothing.
 */
export function runScan(args: Args): number {
  const dryRun = flagBool(args, 'dry-run')
  const verbose = flagBool(args, 'verbose')
  const noBackfill = flagBool(args, 'no-backfill')

  const { state, reset } = loadState()
  const resetReason = describeReset(reset)
  if (verbose && resetReason !== null) {
    console.log(`Starting from an empty record: ${resetReason}.`)
  }

  const started = Date.now()
  let result = emptyResult()
  if (dryRun) {
    result = scanAll(state, { seedOnly: noBackfill })
  } else {
    // commit only writes when usage or file offsets change. An empty scan still updates
    // lastScanAt, and a fresh install must leave a durable state.json behind.
    const wrote = commit(state, 'transcript', (draft) => {
      result = scanAll(draft, { seedOnly: noBackfill })
    })
    if (wrote === null) saveState(state)
  }

  const elapsed = Date.now() - started
  console.log(
    `${dryRun ? '[dry run] ' : ''}Scanned ${result.filesSeen} transcripts ` +
      `(${result.filesChanged} with new data) in ${elapsed}ms.`,
  )
  console.log(`New messages: ${result.messages}. Bytes read: ${result.bytesRead}.`)
  if (result.resyncs > 0) {
    console.log(
      `Resynced ${result.resyncs} rewritten transcript(s) without ingesting, to avoid double-counting.`,
    )
    console.log('Some usage from those files is not recorded.')
  }
  if (dryRun) console.log('Nothing was written.')
  return 0
}
