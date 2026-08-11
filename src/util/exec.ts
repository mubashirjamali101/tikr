import { execFileSync } from 'node:child_process'

/**
 * The single place this codebase shells out.
 *
 * Always `execFile`, never `exec`: the command and each argument are passed as a fixed argv array
 * with no shell in between, so nothing in an argument can be interpreted as a shell metacharacter.
 * Every call site passes literal, hard-coded arguments - no user or file input reaches this - and
 * new call sites must keep it that way.
 */
export function runCapture(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
  } catch {
    return null
  }
}

/** Run a command for its effect, reporting only whether it succeeded. */
export function runQuiet(file: string, args: readonly string[]): boolean {
  try {
    execFileSync(file, [...args], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
