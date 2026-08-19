import { resolveAutostart } from '../autostart/resolve.js'
import { commit } from '../core/commit.js'
import { emptyResult } from '../core/ingest.js'
import { logPath } from '../core/paths.js'
import { scanAll } from '../core/scan.js'
import { loadState } from '../core/state.js'
import { readPid, writePid } from '../daemon/lock.js'
import { spawnDaemon } from '../daemon/spawn.js'
import { DEFAULT_OTLP_PORT } from '../otlp/receiver.js'
import { type Args, flagBool, flagInt } from '../util/args.js'
import { DEFAULT_INTERVAL_SECONDS } from './daemon.js'

/**
 * The one-command setup: catch up on existing history, start the service, and register it to run
 * at login.
 *
 * The initial scan happens in the foreground so the user sees their existing usage immediately
 * rather than an empty report until the first daemon tick.
 */
export function runStart(args: Args): number {
  const intervalSeconds = flagInt(args, 'interval', DEFAULT_INTERVAL_SECONDS)
  const skipAutostart = flagBool(args, 'no-autostart')
  const otlp = flagBool(args, 'otlp')
  const noBackfill = flagBool(args, 'no-backfill')
  const otlpPort = flagInt(args, 'otlp-port', DEFAULT_OTLP_PORT)

  const backend = resolveAutostart()
  const willRegister = !skipAutostart && backend !== null

  const running = readPid()
  if (running !== null) {
    console.log(`Service already running (pid ${running}).`)
  } else {
    const { state } = loadState()
    let result = emptyResult()
    commit(state, 'transcript', (draft) => {
      result = scanAll(draft, { seedOnly: noBackfill })
    })
    console.log(
      noBackfill
        ? `Marked ${result.filesSeen} transcripts as the starting point; counting begins now.`
        : `Indexed ${result.filesSeen} transcript${result.filesSeen === 1 ? '' : 's'}, ` +
            `${result.messages} new message${result.messages === 1 ? '' : 's'}.`,
    )

    if (willRegister) {
      // launchd and systemd both start the service as part of registering it. Spawning here too
      // would leave a second copy fighting over the lockfile and respawning every few seconds.
      console.log(`Starting via ${backend?.name} (scanning every ${intervalSeconds}s).`)
    } else {
      const pid = spawnDaemon({ intervalSeconds, otlp, otlpPort })
      // Record the pid here rather than leaving it to the child. The daemon writes its own pidfile
      // once it boots, which takes long enough that a `stop` issued immediately after `start` would
      // find no pidfile, report "not running", and orphan the process it just launched.
      writePid(pid)
      console.log(`Service started (pid ${pid}, scanning every ${intervalSeconds}s).`)
    }
    console.log(`Log: ${logPath()}`)
    if (otlp) {
      console.log(`OTLP receiver on 127.0.0.1:${otlpPort} - run \`tikr telemetry\` for setup.`)
    }
  }

  if (skipAutostart) {
    console.log('Skipped startup registration (--no-autostart).')
    return 0
  }

  if (backend === null) {
    console.log(`No startup mechanism for platform "${process.platform}".`)
    console.log('Tracking works for this session; run `tikr start` again after a reboot.')
    return 0
  }

  try {
    backend.enable(intervalSeconds, otlp)
    console.log(`Registered to start at login via ${backend.name}.`)
    console.log(`  ${backend.location()}`)
    reportServiceState(willRegister, intervalSeconds, otlp, otlpPort)
  } catch (error) {
    // A failed registration should not fail the whole command - the service is already running.
    console.log(`Could not register for startup: ${error instanceof Error ? error.message : error}`)
    console.log('The service is running now; re-run `tikr enable` to retry.')
  }
  return 0
}

/** How long to wait for the supervisor to actually launch the service before saying it did not. */
const START_TIMEOUT_MS = 4000

/** Sleep without spawning `node -e`, which a bun-compiled `tikr` binary cannot run. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Confirm the service is really running.
 *
 * The supervisor owns the lifecycle when a startup entry is registered, so this command's job ends
 * with "I asked it to start". Reporting that as success without checking is how a user ends up
 * believing they are being tracked when nothing is. If the supervisor did not start it, say so and
 * start it directly rather than leaving them with nothing.
 */
function reportServiceState(
  registered: boolean,
  intervalSeconds: number,
  otlp: boolean,
  otlpPort: number,
): void {
  if (!registered) return

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pid = readPid()
    if (pid !== null) {
      console.log(`Service running (pid ${pid}).`)
      return
    }
    // A compiled bun binary is not Node: `execPath -e` is an unknown flag and would throw here,
    // aborting start after the LaunchAgent was already written.
    sleepSync(250)
  }

  console.log('The startup entry did not launch the service; starting it directly instead.')
  const pid = spawnDaemon({ intervalSeconds, otlp, otlpPort })
  writePid(pid)
  console.log(`Service started (pid ${pid}, scanning every ${intervalSeconds}s).`)
}
