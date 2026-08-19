import { existsSync } from 'node:fs'
import { resolveAutostart } from '../autostart/resolve.js'
import { readPid } from '../daemon/lock.js'
import { terminateDaemon } from '../daemon/terminate.js'
import { type Args, flagBool } from '../util/args.js'

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
    const result = await terminateDaemon()
    if (result === 'timeout') {
      console.error(`Service (pid ${pid}) did not exit in time.`)
      return 1
    }
    console.log(`Service stopped (pid ${pid}).`)
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
