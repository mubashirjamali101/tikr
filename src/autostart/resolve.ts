import { launchdBackend } from './launchd.js'
import { systemdBackend } from './systemd.js'
import type { AutostartBackend } from './types.js'
import { windowsBackend } from './windows.js'

/**
 * The startup mechanism for the current platform, or null where none is supported.
 *
 * Returning null rather than throwing keeps `start` usable on an unsupported platform: usage
 * tracking still works for the current session, and the caller tells the user that only the
 * login-time piece is unavailable.
 */
export function resolveAutostart(
  platform: NodeJS.Platform = process.platform,
): AutostartBackend | null {
  switch (platform) {
    case 'darwin':
      return launchdBackend
    case 'linux':
      return systemdBackend
    case 'win32':
      return windowsBackend
    default:
      return null
  }
}
