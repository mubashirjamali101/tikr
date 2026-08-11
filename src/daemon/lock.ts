import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pidPath } from '../core/paths.js'
import { ensureHome } from '../core/state.js'

/**
 * Is a process with this pid alive and signalable by us?
 *
 * Signal 0 runs the existence and permission checks without delivering anything. A failure means
 * either no such process or one we do not own; the daemon always runs as the current user, so
 * both answer "not our daemon".
 */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Pid of the running daemon, or null. A pidfile left behind by a crash is cleaned up here. */
export function readPid(): number | null {
  let raw: string
  try {
    raw = readFileSync(pidPath(), 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!isRunning(pid)) {
    clearPid()
    return null
  }
  return pid
}

export function writePid(pid: number): void {
  ensureHome()
  writeFileSync(pidPath(), `${pid}\n`, 'utf8')
}

export function clearPid(): void {
  try {
    rmSync(pidPath())
  } catch {
    // Already gone - nothing to do.
  }
}
