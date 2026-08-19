import { clearPid, isRunning, readPid } from './lock.js'

const STOP_TIMEOUT_MS = 5_000
const POLL_MS = 100

/**
 * Ask the running daemon to exit. Does not touch the login registration.
 *
 * Used by `stop` and by `start` when the service is up but was launched without the OTLP
 * receiver that a just-detected tool needs.
 */
export async function terminateDaemon(): Promise<'stopped' | 'not-running' | 'timeout'> {
  const pid = readPid()
  if (pid === null) return 'not-running'
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    clearPid()
    return 'not-running'
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      clearPid()
      return 'stopped'
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return isRunning(pid) ? 'timeout' : 'stopped'
}
