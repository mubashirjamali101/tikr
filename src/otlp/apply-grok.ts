import { apply } from '../core/fold.js'
import type { State } from '../core/types.js'
import { grokOtlpFile, grokProvider } from '../providers/grok.js'
import type { UsageObservation } from '../providers/types.js'

/** Fold one Grok API-request observation into the main ledger. */
export function applyGrok(state: State, observation: UsageObservation): boolean {
  return apply(state, grokProvider, 'grok', grokOtlpFile(state), observation)
}
