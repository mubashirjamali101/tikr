import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSealed, open, seal } from '../crypto/seal.js'
import { emptyLimits } from './limits.js'
import { counterHome, statePath } from './paths.js'
import { STATE_VERSION, type State, emptyOtel, emptyState, recordedTokens } from './types.js'

export type ResetReason = 'none' | 'missing' | 'corrupt' | 'version' | 'recovered'

/** Every state layout this build can read. See the migration note in `readCandidate`. */
const SUPPORTED_VERSIONS = new Set([1, 2, STATE_VERSION])

/** Human-readable explanation of a load that did not use the primary state file. */
export function describeReset(reset: ResetReason): string | null {
  switch (reset) {
    case 'corrupt':
      return 'the state file could not be read and no usable backup was found'
    case 'version':
      return 'the state file was written by an incompatible version'
    case 'recovered':
      return 'the state file was damaged and was restored from the backup copy'
    default:
      return null
  }
}

function backupPath(): string {
  return join(counterHome(), 'state.backup.json')
}

export function ensureHome(): void {
  // 0700: the files inside are 0600, but an owner-only directory also hides which files exist.
  mkdirSync(counterHome(), { recursive: true, mode: 0o700 })
}

/** Set the fields a state file may legitimately omit, so an older or partial file still loads. */
function hydrate(candidate: Partial<State>): State {
  return {
    version: STATE_VERSION,
    createdAt: candidate.createdAt ?? new Date().toISOString(),
    lastScanAt: candidate.lastScanAt ?? null,
    resyncs: candidate.resyncs ?? 0,
    pruned: candidate.pruned ?? { count: 0, lastAt: null },
    files: candidate.files ?? {},
    daily: candidate.daily ?? {},
    // Version 3 additions. An older file simply has none of this yet: the transcript bytes it was
    // built from are already consumed and are never re-read, so these start empty and fill from the
    // next message onward. The day totals it already holds are untouched.
    hourly: candidate.hourly ?? {},
    projects: candidate.projects ?? {},
    lastActivityAt: candidate.lastActivityAt ?? null,
    limits: { ...emptyLimits(), ...(candidate.limits ?? {}) },
    otel: { ...emptyOtel(), ...(candidate.otel ?? {}) },
  }
}

type Candidate =
  | { ok: true; state: State }
  | { ok: false; why: 'absent' | 'unreadable' | 'version' }

function readCandidate(path: string): Candidate {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, why: 'absent' }
  }
  try {
    let parsed: unknown = JSON.parse(raw)
    // Files written before encryption was added are plain JSON; they load and are re-sealed on the
    // next write rather than being rejected.
    if (isSealed(parsed)) parsed = JSON.parse(open(parsed))
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, why: 'unreadable' }
    const candidate = parsed as Partial<State>
    // Older versions differ only by sections that were added, never by a changed meaning, so they
    // are migrated rather than discarded. Discarding would be permanent loss: ingested transcript
    // bytes are never re-read. 1 predates telemetry; 2 predates hourly buckets and limit events.
    if (!SUPPORTED_VERSIONS.has(candidate.version ?? 0)) {
      return { ok: false, why: 'version' }
    }
    return { ok: true, state: hydrate(candidate) }
  } catch {
    return { ok: false, why: 'unreadable' }
  }
}

/** Read a file we only need for comparison, ignoring why it could not be read. */
function readUsable(path: string): State | null {
  const candidate = readCandidate(path)
  return candidate.ok ? candidate.state : null
}

/** Keep an unreadable state file instead of overwriting it, so it can be inspected or salvaged. */
function quarantine(path: string): void {
  try {
    copyFileSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    // Nothing to preserve.
  }
}

/**
 * Load the recorded usage.
 *
 * This file is the only copy of usage that predates Claude Code's retention window, so a damaged
 * primary falls back to the backup rather than starting over. Starting over is not recoverable:
 * transcripts are deleted after `cleanupPeriodDays` (30 by default), and already-ingested bytes are
 * never re-read.
 */
export function loadState(): { state: State; reset: ResetReason } {
  const primary = readCandidate(statePath())
  if (primary.ok) return { state: primary.state, reset: 'none' }
  if (primary.why === 'absent') return { state: emptyState(), reset: 'missing' }

  // The primary exists but is unusable. Prefer the backup over starting from nothing: recorded
  // usage cannot be rebuilt once Claude Code has deleted the transcripts it came from.
  const backup = readCandidate(backupPath())
  quarantine(statePath())
  if (backup.ok) return { state: backup.state, reset: 'recovered' }

  return { state: emptyState(), reset: primary.why === 'version' ? 'version' : 'corrupt' }
}

export class StateRegressionError extends Error {
  constructor(
    readonly existing: number,
    readonly incoming: number,
  ) {
    super(
      `refusing to write state: recorded tokens would drop from ${existing.toLocaleString()} to ` +
        `${incoming.toLocaleString()}. Usage only ever accumulates, so this is a bug or corruption.`,
    )
    this.name = 'StateRegressionError'
  }
}

/**
 * Write state atomically, refusing any write that would lose recorded usage.
 *
 * Recorded totals only ever grow: transcripts are read once and folded in, and Claude Code deleting
 * the underlying file later must not take the tokens with it. So a write whose total is lower than
 * what is already on disk means something went wrong upstream, and the safe response is to keep the
 * larger record and fail loudly. `reset` passes `force` to delete deliberately.
 */
export function saveState(state: State, options: { force?: boolean } = {}): void {
  ensureHome()
  const target = statePath()

  const existing = readUsable(target)
  if (existing !== null) {
    const before = recordedTokens(existing)
    const after = recordedTokens(state)
    if (after < before && options.force !== true) {
      throw new StateRegressionError(before, after)
    }
    // Keep the last good version alongside, so a crash mid-write leaves something to recover from.
    try {
      copyFileSync(target, backupPath())
    } catch {
      // A missing backup is not worth failing the write over.
    }
  }

  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(seal(JSON.stringify(state)))}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(temp, target)
}
