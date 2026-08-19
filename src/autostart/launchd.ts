import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { counterHome, logPath } from '../core/paths.js'
import { daemonInvocation } from '../daemon/spawn.js'
import type { AutostartBackend } from './types.js'

export const LABEL = 'com.tikr.agent'

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * A LaunchAgent that runs the daemon at login and restarts it if it dies.
 *
 * `RunAtLoad` starts it at login. `KeepAlive` is conditional on a *failed* exit: an unconditional
 * KeepAlive would restart the service seconds after `tikr stop`, and would also respawn
 * endlessly while another copy already holds the lockfile. The two custom
 * environment variables are forwarded so a user who redirected either home directory keeps that
 * setting after a reboot - launchd does not inherit the shell environment.
 */
export function plistFor(intervalSeconds: number, otlp = false): string {
  const args = daemonInvocation({ intervalSeconds, otlp })
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')

  const env: Record<string, string> = { TIKR_HOME: counterHome() }
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath())}</string>
</dict>
</plist>
`
}

/** Run launchctl, reporting whether it succeeded rather than swallowing the answer. */
function launchctl(args: string[]): boolean {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function target(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

export const launchdBackend: AutostartBackend = {
  name: 'launchd LaunchAgent',
  location: plistPath,

  enable(intervalSeconds: number, otlp = false): void {
    const path = plistPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, plistFor(intervalSeconds, otlp), 'utf8')
    // Replace any previous registration so an interval change actually takes effect.
    // `bootout` fails when nothing is loaded, which is the normal first-run case, so its result is
    // ignored. `bootstrap` is the call that starts the service, and it fails while the previous
    // instance is still tearing down - which is exactly what a `stop` immediately followed by a
    // `start` produces. Swallowing that left the user registered with nothing running, so a failed
    // bootstrap falls back to kickstart, which starts an already-loaded job.
    launchctl(['bootout', `${target()}/${LABEL}`])
    if (!launchctl(['bootstrap', target(), path])) {
      launchctl(['kickstart', '-k', `${target()}/${LABEL}`])
    }
    launchctl(['enable', `${target()}/${LABEL}`])
  },

  disable(): void {
    launchctl(['bootout', `${target()}/${LABEL}`])
    try {
      rmSync(plistPath())
    } catch {
      // Not installed.
    }
  },
}
