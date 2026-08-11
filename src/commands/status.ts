import { existsSync } from 'node:fs'
import { resolveAutostart } from '../autostart/resolve.js'
import { counterHome, logPath, statePath, transcriptsRoot } from '../core/paths.js'
import { listTranscripts } from '../core/scan.js'
import { describeReset, loadState } from '../core/state.js'
import { recordedTokens } from '../core/types.js'
import { readPid } from '../daemon/lock.js'
import { count, since } from '../report/format.js'

/** Everything needed to answer "is this thing working, and where does it keep my data?". */
export function runStatus(): number {
  const pid = readPid()
  const { state, reset } = loadState()
  const backend = resolveAutostart()
  const transcripts = listTranscripts()

  const rows: Array<[string, string]> = [
    ['Service', pid === null ? 'stopped' : `running (pid ${pid})`],
    ['Last scan', since(state.lastScanAt)],
    ['Transcripts found', String(transcripts.length)],
    ['Files tracked', String(Object.keys(state.files).length)],
    ['Days recorded', String(Object.keys(state.daily).length)],
    ['Hours recorded', String(Object.keys(state.hourly).length)],
    ['Projects recorded', String(Object.keys(state.projects).length)],
  ]

  if (state.limits.events.length > 0) {
    const last = state.limits.events[state.limits.events.length - 1]
    rows.push([
      'Usage limits hit',
      `${state.limits.events.length} (last ${since(last?.at ?? null)})`,
    ])
  }

  rows.push(['Tokens recorded', count(recordedTokens(state))])

  if (state.resyncs > 0) {
    rows.push(['Resyncs', `${state.resyncs} (a transcript was rewritten; see docs/LESSONS.md)`])
  }

  if (state.pruned.count > 0) {
    rows.push([
      'Deleted by Claude',
      `${state.pruned.count} transcripts (their tokens are still counted here)`,
    ])
  }

  rows.push([
    'Telemetry feed',
    state.otel.active
      ? `receiving (last event ${since(state.otel.lastEventAt)})`
      : 'not configured (run `tikr telemetry`)',
  ])

  if (backend === null) {
    rows.push(['Start at login', `unsupported on ${process.platform}`])
  } else {
    const installed = existsSync(backend.location())
    rows.push([
      'Start at login',
      installed ? `enabled (${backend.name})` : `disabled (${backend.name} available)`,
    ])
  }

  rows.push(['State dir', counterHome()])
  rows.push(['Watching', transcriptsRoot()])
  rows.push(['Log', logPath()])

  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`)
  }

  // A record that predates hourly buckets cannot have them back-filled: the transcript bytes were
  // read once and are not re-read. Say so once, here, rather than leaving an empty view unexplained.
  if (Object.keys(state.daily).length > 0 && Object.keys(state.hourly).length === 0) {
    console.log('\nBlocks and the hour-of-week view start from your next message: this record was')
    console.log(
      'written before usage was bucketed by hour, and history cannot be rebuilt for them.',
    )
    console.log('Day, project and model totals are unaffected.')
  }

  const resetReason = describeReset(reset)
  if (resetReason !== null) {
    const recovered = reset === 'recovered'
    console.log(`\n${recovered ? 'Note' : 'Warning'}: ${resetReason}.`)
    if (!recovered) console.log(`  ${statePath()} - a fresh record will be written.`)
  }
  if (!existsSync(transcriptsRoot())) {
    console.log(`\nNo Claude Code data directory at ${transcriptsRoot()}.`)
    console.log('Set CLAUDE_CONFIG_DIR if Claude Code stores its data elsewhere.')
  }
  if (state.pruned.count > 0) {
    console.log(
      `\nClaude Code has deleted ${state.pruned.count} of the transcripts this tool has counted.`,
    )
    console.log('It removes sessions older than `cleanupPeriodDays` (default 30) at startup, so')
    console.log('anything recomputed from the files on disk shrinks over time. The totals here do')
    console.log("not: they are this tool's own record and are only ever added to.")
  }
  return 0
}
