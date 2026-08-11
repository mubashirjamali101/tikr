import { readPayloads, verifyLedger } from './ledger-verify.js'
import { appendEntry } from './ledger.js'
import { diffSnapshots, rebuildFrom, snapshotOf } from './snapshot.js'
import { loadState, saveState } from './state.js'
import type { State } from './types.js'

/**
 * Run a mutation and record what it changed, to the ledger first and the cache second.
 *
 * Order matters. The ledger is the record; `state.json` is a rebuildable cache of it. Appending
 * first means a crash between the two leaves the ledger ahead of the cache, which `recover` can
 * repair. The reverse would leave the cache holding numbers with no entry to prove them.
 *
 * Returns the deltas that were recorded, or null when nothing changed.
 */
export function commit(
  state: State,
  source: 'transcript' | 'telemetry',
  mutate: (state: State) => void,
): Record<string, number> | null {
  const before = snapshotOf(state)
  const filesBefore = new Map<string, string>()
  for (const [path, position] of Object.entries(state.files)) {
    filesBefore.set(path, `${position.offset}:${position.size}`)
  }

  mutate(state)

  const deltas = diffSnapshots(before, snapshotOf(state))

  // Only offsets that actually moved. Embedding the whole map would make every entry grow with the
  // number of transcripts ever seen, which for a ledger meant to be kept forever compounds badly.
  const files: Record<string, { offset: number; size: number }> = {}
  for (const [path, position] of Object.entries(state.files)) {
    if (filesBefore.get(path) !== `${position.offset}:${position.size}`) {
      files[path] = { offset: position.offset, size: position.size }
    }
  }

  if (Object.keys(deltas).length === 0 && Object.keys(files).length === 0) return null

  appendEntry({ at: new Date().toISOString(), source, deltas, files })
  saveState(state)
  return deltas
}

export interface RecoverResult {
  rebuilt: boolean
  entries: number
  reason: string | null
}

/**
 * Restore the cache from the ledger when the two disagree.
 *
 * Used when `state.json` is missing, damaged, or behind the ledger. The ledger is verified first:
 * rebuilding from a broken chain would launder tampered data into a clean-looking cache.
 */
export function recoverFromLedger(): RecoverResult {
  const verification = verifyLedger()
  if (verification.entries === 0) {
    return { rebuilt: false, entries: 0, reason: 'the ledger is empty' }
  }
  if (!verification.ok) {
    return {
      rebuilt: false,
      entries: verification.entries,
      reason: `the ledger failed verification at entry ${verification.brokenAt}: ${verification.reason}`,
    }
  }

  const rebuilt = rebuildFrom(readPayloads())
  const current = loadState().state
  const currentTotal = totalOf(current)
  const rebuiltTotal = totalOf(rebuilt)
  if (rebuiltTotal <= currentTotal) {
    return {
      rebuilt: false,
      entries: verification.entries,
      reason: 'the cache already holds everything the ledger records',
    }
  }

  // The cache is behind the ledger, so replace it. `force` is required because the guard that
  // normally blocks shrinking writes cannot tell this apart from data loss.
  rebuilt.createdAt = current.createdAt
  saveState(rebuilt, { force: true })
  return { rebuilt: true, entries: verification.entries, reason: null }
}

function totalOf(state: State): number {
  let sum = 0
  for (const byModel of Object.values(state.daily)) {
    for (const totals of Object.values(byModel)) {
      sum +=
        totals.input + totals.output + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead
    }
  }
  return sum
}
