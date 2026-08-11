import { execFileSync } from 'node:child_process'
import { daemonArgs, entryScript, nodeBinary } from '../daemon/spawn.js'
import type { AutostartBackend } from './types.js'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'Tikr'

/**
 * Per-user `Run` registry key - the least invasive Windows startup mechanism.
 *
 * It needs no elevation (HKCU, not HKLM) and no Task Scheduler XML. The tradeoff is that Windows
 * does not restart the process if it dies; `tikr start` re-launches it, and the next
 * login re-runs it regardless.
 */
function command(intervalSeconds: number, otlp: boolean): string {
  const args = daemonArgs({ intervalSeconds, otlp }).join(' ')
  return `"${nodeBinary()}" "${entryScript()}" ${args}`
}

function reg(args: string[]): void {
  execFileSync('reg', args, { stdio: 'ignore' })
}

export const windowsBackend: AutostartBackend = {
  name: 'Windows Run registry key',
  location: () => `${RUN_KEY}\\${VALUE_NAME}`,

  enable(intervalSeconds: number, otlp = false): void {
    // /f overwrites an existing value, making repeat enables idempotent.
    reg([
      'add',
      RUN_KEY,
      '/v',
      VALUE_NAME,
      '/t',
      'REG_SZ',
      '/d',
      command(intervalSeconds, otlp),
      '/f',
    ])
  },

  disable(): void {
    try {
      reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
    } catch {
      // Value not present.
    }
  },
}
