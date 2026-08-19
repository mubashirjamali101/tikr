import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { logPath } from '../core/paths.js'
import { ensureHome } from '../core/state.js'

/**
 * Absolute path to this CLI's entry script.
 *
 * Used both to re-launch ourselves as a daemon and to write startup entries, so it must be a real
 * file path rather than whatever `argv[1]` happened to be (a shim, a symlink in a temp dir).
 */
export function entryScript(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url))
}

export function nodeBinary(): string {
  return process.execPath
}

/**
 * Bun `--compile` embeds the entry as `/$bunfs/cli.js`. That path is not a file, and passing it as
 * argv makes the CLI treat it as a command (`Unknown command "/$bunfs/cli.js"`), so a LaunchAgent
 * written that way crash-loops and never runs the daemon.
 */
export function isEmbeddedBinary(metaUrl = import.meta.url): boolean {
  return metaUrl.includes('$bunfs')
}

/**
 * Full command line to re-launch this process as the daemon.
 *
 * Node: `node dist/cli.js daemon --interval 15`. A compiled binary is already the CLI, so just
 * `tikr daemon --interval 15`.
 */
export function daemonInvocation(options: SpawnOptions): string[] {
  if (isEmbeddedBinary()) return [nodeBinary(), ...daemonArgs(options)]
  return [nodeBinary(), entryScript(), ...daemonArgs(options)]
}

export interface SpawnOptions {
  intervalSeconds: number
  /** Run the OTLP receiver so Claude Code can push telemetry to us. */
  otlp?: boolean
  otlpPort?: number
}

/** Daemon argv, shared by the spawner and by the platform startup entries. */
export function daemonArgs(options: SpawnOptions): string[] {
  const args = ['daemon', '--interval', String(options.intervalSeconds)]
  if (options.otlp === true) {
    args.push('--otlp')
    if (options.otlpPort !== undefined) args.push('--otlp-port', String(options.otlpPort))
  }
  return args
}

/**
 * Start the daemon detached, with stdio pointed at the log file.
 *
 * Detaching and unref-ing lets the parent exit immediately while the child keeps running. Both
 * stdout and stderr go to the log so a crash leaves a stack trace on disk rather than vanishing
 * with the terminal.
 */
export function spawnDaemon(options: SpawnOptions): number {
  ensureHome()
  const out = openSync(logPath(), 'a')
  const argv = daemonInvocation(options)
  const command = argv[0] ?? nodeBinary()
  const args = argv.slice(1)
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
    // Without this, a detached child on Windows opens its own console window that then sits on the
    // desktop for the life of the service. It is ignored on macOS and Linux.
    windowsHide: true,
  })
  child.unref()
  if (child.pid === undefined) {
    throw new Error('failed to spawn the background service')
  }
  return child.pid
}
