import { existsSync } from 'node:fs'
import { resolveAutostart } from '../autostart/resolve.js'
import { clearPid, isRunning, readPid } from '../daemon/lock.js'
import { type Args, flagBool } from '../util/args.js'

const STOP_TIMEOUT_MS = 5_000
const POLL_MS = 100

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return !isRunning(pid)
}

/**
 * Stop the background service.
 *
 * Stopping the process alone is not enough on a machine where autostart is registered with a
 * keep-alive policy (launchd and systemd both restart it), so `--disable` removes the registration
 * too. Without that flag the service comes back at next login, which is usually what "stop for now"
 * means.
 */
export async function runStop(args: Args): Promise<number> {
  const alsoDisable = flagBool(args, 'disable')
  const pid = readPid()

  if (pid === null) {
    console.log('Service is not running.')
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      console.error(
        `Could not signal pid ${pid}: ${error instanceof Error ? error.message : error}`,
      )
      return 1
    }
    if (await waitForExit(pid)) {
      console.log(`Service stopped (pid ${pid}).`)
      clearPid()
    } else {
      console.error(`Service (pid ${pid}) did not exit within ${STOP_TIMEOUT_MS / 1000}s.`)
      return 1
    }
  }

  const backend = resolveAutostart()
  const registered = backend !== null && existsSync(backend.location())

  if (!alsoDisable) {
    // Only mention the registration when one actually exists, otherwise this reads as though the
    // service will come back when nothing will bring it back.
    if (registered) {
      console.log('Startup registration left in place; it will start again at login.')
      console.log('Run `tikr stop --disable` to remove it.')
    }
    return 0
  }

  if (backend === null) {
    console.log('No startup registration to remove on this platform.')
    return 0
  }
  if (!registered) {
    console.log('No startup registration to remove.')
    return 0
  }
  backend.disable()
  console.log(`Removed startup registration (${backend.name}).`)
  return 0
}
