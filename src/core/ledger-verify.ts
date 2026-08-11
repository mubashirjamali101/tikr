import { open } from '../crypto/seal.js'
import { GENESIS, type LedgerPayload, linkHash, readLines } from './ledger.js'
export interface VerifyResult {
  entries: number
  ok: boolean
  /** 1-based position of the first bad entry, or null when the chain is intact. */
  brokenAt: number | null
  reason: string | null
}

/**
 * Walk the whole chain, checking both the links and the authentication tags.
 *
 * A link check catches removal, reordering, or insertion of entries. A tag check catches any edit
 * to the encrypted contents. Together they mean the only undetectable change is deleting the file
 * outright.
 */
export function verifyLedger(): VerifyResult {
  const lines = readLines()
  let prev = GENESIS

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const position = index + 1

    if (line.seq === -1) {
      return { entries: lines.length, ok: false, brokenAt: position, reason: 'unparseable entry' }
    }
    if (line.seq !== position) {
      return {
        entries: lines.length,
        ok: false,
        brokenAt: position,
        reason: `sequence jumped to ${line.seq}; an entry was removed or inserted`,
      }
    }
    if (line.prev !== prev) {
      return {
        entries: lines.length,
        ok: false,
        brokenAt: position,
        reason: 'chain link does not match the previous entry',
      }
    }
    if (linkHash(line.seq, line.prev, line.body) !== line.hash) {
      return {
        entries: lines.length,
        ok: false,
        brokenAt: position,
        reason: 'entry hash does not match its contents',
      }
    }
    try {
      open(line.body)
    } catch {
      return {
        entries: lines.length,
        ok: false,
        brokenAt: position,
        reason: 'decryption failed: the entry was altered, or written on another machine',
      }
    }
    prev = line.hash
  }

  return { entries: lines.length, ok: true, brokenAt: null, reason: null }
}

/** Decrypt every entry in order. Throws on the first that fails authentication. */
export function readPayloads(): LedgerPayload[] {
  return readLines().map((line) => JSON.parse(open(line.body)) as LedgerPayload)
}
