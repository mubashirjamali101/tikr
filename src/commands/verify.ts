import { existsSync, statSync } from 'node:fs'
import { recoverFromLedger } from '../core/commit.js'
import { verifyLedger } from '../core/ledger-verify.js'
import { ledgerPath } from '../core/ledger.js'
import { loadState } from '../core/state.js'
import { recordedTokens } from '../core/types.js'
import { machineIdentity } from '../crypto/machine.js'
import { count } from '../report/format.js'
import { type Args, flagBool } from '../util/args.js'

/**
 * Check that the stored history is intact, and optionally repair the cache from it.
 *
 * Every claim printed here is checked rather than asserted: the chain is walked link by link and
 * every entry is decrypted, so a failure names the exact entry that broke.
 */
export function runVerify(args: Args): number {
  const path = ledgerPath()
  if (!existsSync(path)) {
    console.log('No ledger yet. It is created the first time usage is recorded.')
    return 0
  }

  const identity = machineIdentity()
  const result = verifyLedger()
  const size = statSync(path).size

  console.log(`Ledger:   ${path}`)
  console.log(`Entries:  ${count(result.entries)}  (${count(size)} bytes)`)
  console.log(`Machine:  ${identity.strong ? 'hardware id' : 'hostname fallback (weaker)'}`)
  console.log('')

  if (!result.ok) {
    console.error(`FAILED at entry ${result.brokenAt} of ${result.entries}: ${result.reason}`)
    console.error('')
    console.error('The recorded history has been altered, truncated, or copied from another')
    console.error('machine. Entries before the break are still intact and verifiable.')
    return 1
  }

  console.log('Chain intact. Every entry decrypts and links to the one before it.')
  console.log('Nothing has been edited, removed, or reordered.')

  const { state } = loadState()
  console.log(`Cache:    ${count(recordedTokens(state))} tokens recorded`)

  if (flagBool(args, 'rebuild')) {
    const recovery = recoverFromLedger()
    console.log('')
    if (recovery.rebuilt) {
      console.log(`Rebuilt the cache from ${count(recovery.entries)} ledger entries.`)
      console.log(`Now recording ${count(recordedTokens(loadState().state))} tokens.`)
    } else {
      console.log(`No rebuild needed: ${recovery.reason}.`)
    }
  }
  return 0
}
