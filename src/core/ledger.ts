import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { type Sealed, isSealed, seal } from '../crypto/seal.js'
import { counterHome } from './paths.js'
import { ensureHome } from './state.js'

export function ledgerPath(): string {
  return join(counterHome(), 'ledger.jsonl')
}

/** The payload of one ledger entry, encrypted before it touches disk. */
export interface LedgerPayload {
  at: string
  source: 'transcript' | 'telemetry' | 'checkpoint'
  /** Flat `bucket -> token count` increments. See `snapshot.ts` for the key format. */
  deltas: Record<string, number>
  /** Transcript read offsets as of this entry, so a rebuild does not re-count anything. */
  files?: Record<string, { offset: number; size: number }>
}

/**
 * One line of the ledger.
 *
 * `seq`, `prev` and `hash` are plaintext on purpose: they let the chain be verified, and tampering
 * be located, without decrypting anything. Hashes reveal nothing about the contents.
 */
export interface LedgerLine {
  seq: number
  prev: string
  hash: string
  body: Sealed
}

export const GENESIS = '0'.repeat(64)

/** Chain link: binds this entry to every entry before it. */
export function linkHash(seq: number, prev: string, body: Sealed): string {
  return createHash('sha256')
    .update(`${seq}\n${prev}\n${body.iv}\n${body.ct}\n${body.tag}`)
    .digest('hex')
}

export function readLines(): LedgerLine[] {
  const path = ledgerPath()
  if (!existsSync(path)) return []
  const out: LedgerLine[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<LedgerLine>
      if (
        typeof parsed.seq === 'number' &&
        typeof parsed.prev === 'string' &&
        typeof parsed.hash === 'string' &&
        isSealed(parsed.body)
      ) {
        out.push(parsed as LedgerLine)
      } else {
        out.push({ seq: -1, prev: '', hash: '', body: { v: 1, iv: '', ct: '', tag: '' } })
      }
    } catch {
      // A malformed line is still a break in the chain; record it as such rather than skipping.
      out.push({ seq: -1, prev: '', hash: '', body: { v: 1, iv: '', ct: '', tag: '' } })
    }
  }
  return out
}

/**
 * The last entry, read from the tail of the file rather than by parsing all of it.
 *
 * Appending is the hot path and the ledger is never truncated, so reading the whole file to find
 * the head would make each append cost O(n) and the ledger O(n^2) to build over its lifetime.
 */
function readLastLine(): LedgerLine | null {
  const path = ledgerPath()
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (size === 0) return null

  // Read backwards in growing windows until the whole final line is in hand.
  //
  // The window must contain the newline that *starts* the last line, not just the trailing one.
  // A window smaller than the final entry yields a fragment that fails to parse, and treating that
  // as "no entries" restarts the sequence at 1 and breaks the chain. The first backfill entry can
  // be tens of kilobytes, so the windows have to reach well past a typical entry.
  const fd = openSync(path, 'r')
  try {
    for (const window of [8192, 262_144, 4_194_304, size]) {
      const length = Math.min(window, size)
      const buffer = Buffer.allocUnsafe(length)
      readSync(fd, buffer, 0, length, size - length)

      const text = buffer.toString('utf8').replace(/\n+$/, '')
      const start = text.lastIndexOf('\n')
      const reachedStartOfFile = length === size

      if (start === -1 && !reachedStartOfFile) continue // window clipped the line; grow it
      const candidate = text.slice(start + 1)
      if (candidate.trim().length === 0) return null

      try {
        return JSON.parse(candidate) as LedgerLine
      } catch {
        // Either the window still clips the line, or the last line is genuinely corrupt. Grow
        // once more to tell the two apart; `verifyLedger` reports it either way.
        if (reachedStartOfFile) return null
      }
    }
  } finally {
    closeSync(fd)
  }
  return null
}

/** Hash of the last entry, which the next entry chains onto. */
export function headHash(): string {
  return readLastLine()?.hash ?? GENESIS
}

/**
 * Append one entry.
 *
 * Opened in append mode and never rewritten, so recorded history only grows. There is no code path
 * in this tool that edits or removes a ledger line - deleting history means deleting the file, and
 * that is detectable because the chain no longer reaches the recorded head.
 */
export function appendEntry(payload: LedgerPayload): LedgerLine {
  ensureHome()
  const last = readLastLine()
  const seq = last === null ? 1 : last.seq + 1
  const prev = last === null ? GENESIS : last.hash

  const body = seal(JSON.stringify(payload))
  const entry: LedgerLine = { seq, prev, hash: linkHash(seq, prev, body), body }

  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(ledgerPath(), 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return entry
}
