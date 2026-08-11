import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { runCapture } from '../util/exec.js'

/**
 * A stable identifier for this machine.
 *
 * Mixed into the encryption key so a ledger copied to another computer cannot be decrypted there.
 * Each platform exposes an install-scoped UUID that survives reboots but differs between machines.
 */
function platformId(): string | null {
  if (process.platform === 'darwin') {
    const out = runCapture('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    return out === null ? null : (/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null)
  }

  if (process.platform === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(path, 'utf8').trim()
        if (id.length > 0) return id
      } catch {
        // Try the next location.
      }
    }
    return null
  }

  if (process.platform === 'win32') {
    const out = runCapture('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ])
    return out === null ? null : (/MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null)
  }

  return null
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

let cached: { id: string; strong: boolean } | null = null

/**
 * Machine and user identity, as one string.
 *
 * Falls back to hostname plus username when no platform UUID is available. That fallback is weaker,
 * since a hostname is easy to reproduce elsewhere, but it keeps the tool working rather than
 * refusing to run. `tikr verify` reports which of the two was used.
 */
export function machineIdentity(): { id: string; strong: boolean } {
  if (cached !== null) return cached
  const platform = platformId()
  const user = safeUsername()
  cached =
    platform === null
      ? { id: `weak:${hostname()}:${user}`, strong: false }
      : { id: `${platform}:${user}`, strong: true }
  return cached
}

/** Test seam: forget the memoised identity. */
export function resetMachineIdentityCache(): void {
  cached = null
}
