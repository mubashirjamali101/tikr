import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * All filesystem locations the tool touches.
 *
 * Two environment variables exist so tests (and curious users) can point the tool at fixtures
 * instead of real data:
 *   TIKR_HOME         - where this tool stores its own state (default ~/.tikr)
 *   CLAUDE_CONFIG_DIR - where Claude Code stores its data (default ~/.claude)
 *
 * Everything is resolved lazily so a test can set the env var after import.
 */

/**
 * What the state directory was called before the tool was renamed to tikr.
 *
 * This literal is the whole point of the migration below, so it must never be swept up by a
 * search-and-replace of the old name. It was, once, and the tests were rewritten in the same pass
 * so they still passed while the migration had quietly become a no-op.
 */
const FORMER_HOME = '.claude-counter'

/**
 * Adopt a record written under the old name.
 *
 * The directory holds an append-only encrypted ledger whose contents cannot be rebuilt: the
 * transcripts behind most of it have already been deleted by Claude Code. So a rename must carry
 * the record over rather than quietly start a new one, which would look exactly like the total
 * dropping to zero.
 *
 * The whole directory moves, salt file included, so the per-install key still derives. A move
 * rather than a copy, because two divergent copies of an append-only ledger is a worse problem
 * than either copy alone. It happens once: afterwards the old path no longer exists.
 */
function adoptFormerHome(target: string): void {
  if (existsSync(target)) return
  const former = join(homedir(), FORMER_HOME)
  if (!existsSync(former)) return
  try {
    renameSync(former, target)
  } catch {
    // A cross-device move or a permission problem leaves the old directory untouched and the tool
    // starts fresh. Losing the history silently is not acceptable, so say so rather than pretend.
    console.error(`Could not move ${former} to ${target}; the previous record is still there.`)
  }
}

export function counterHome(): string {
  const override = process.env.TIKR_HOME
  if (override && override.length > 0) return override
  const home = join(homedir(), '.tikr')
  adoptFormerHome(home)
  return home
}

export function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.length > 0 ? override : join(homedir(), '.claude')
}

/** Directory holding one subdirectory per project, each with session `.jsonl` transcripts. */
export function transcriptsRoot(): string {
  return join(claudeHome(), 'projects')
}

export function statePath(): string {
  return join(counterHome(), 'state.json')
}

export function pidPath(): string {
  return join(counterHome(), 'daemon.pid')
}

export function logPath(): string {
  return join(counterHome(), 'daemon.log')
}

/**
 * Claude Code encodes a project's working directory into a single directory name by replacing
 * path separators with dashes: `/Users/me/code/foo` becomes `-Users-me-code-foo`. There is no
 * lossless inverse (a real dash in a directory name is indistinguishable from a separator), so
 * this is a best-effort label for display only - never use it to build a path.
 */
export function decodeProjectLabel(encoded: string): string {
  if (!encoded.startsWith('-')) return encoded
  return `/${encoded.slice(1).replaceAll('-', '/')}`
}
