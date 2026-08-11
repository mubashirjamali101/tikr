import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { counterHome } from '../core/paths.js'
import { daemonArgs, entryScript, nodeBinary } from '../daemon/spawn.js'
import type { AutostartBackend } from './types.js'

export const UNIT = 'tikr.service'

function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'systemd', 'user', UNIT)
}

/**
 * A systemd *user* unit - no root, no sudo, and it starts with the user's session.
 *
 * `WantedBy=default.target` is the user-session equivalent of "at login". `Restart=on-failure` covers
 * crashes. Environment is set explicitly because a user unit does not inherit the shell's.
 */
export function unitFor(intervalSeconds: number, otlp = false): string {
  const exec = [nodeBinary(), entryScript(), ...daemonArgs({ intervalSeconds, otlp })]
    .map((part) => (part.includes(' ') ? `"${part}"` : part))
    .join(' ')

  const environment = [`Environment=TIKR_HOME=${counterHome()}`]
  if (process.env.CLAUDE_CONFIG_DIR) {
    environment.push(`Environment=CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`)
  }

  return `[Unit]
Description=tikr usage tracking service
After=default.target

[Service]
Type=simple
ExecStart=${exec}
${environment.join('\n')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

function systemctl(args: string[]): void {
  try {
    execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' })
  } catch {
    // Common on headless boxes with no user session bus. The unit file is still written, so the
    // service starts on the next login even when we cannot talk to systemd right now.
  }
}

export const systemdBackend: AutostartBackend = {
  name: 'systemd user unit',
  location: unitPath,

  enable(intervalSeconds: number, otlp = false): void {
    const path = unitPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, unitFor(intervalSeconds, otlp), 'utf8')
    systemctl(['daemon-reload'])
    systemctl(['enable', UNIT])
    systemctl(['restart', UNIT])
  },

  disable(): void {
    systemctl(['stop', UNIT])
    systemctl(['disable', UNIT])
    try {
      rmSync(unitPath())
    } catch {
      // Not installed.
    }
    systemctl(['daemon-reload'])
  },
}
