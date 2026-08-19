import { existsSync } from 'node:fs'
import type { FileState, State } from '../core/types.js'
import { grokHome, setupGrok } from './grok-setup.js'
import type { Provider, UsageSource } from './types.js'

export { grokHome }

/**
 * Grok CLI / Grok Build.
 *
 * Verified against a real `~/.grok` install (2026-08-20): session jsonl has messages, model id,
 * tools and latency, but no per-turn input/output/cache tokens. `signals.json` only restates
 * current context-window occupancy. The numbers tikr can trust are OTLP log events
 * `grok_code.api_request`, which Grok emits when the external OTEL stream is on.
 *
 * This provider therefore discovers no files. The daemon folds OTLP observations through `applyGrok`
 * into the same ledger as the file-backed tools, namespaced `grok/<model>`.
 */
export const GROK_OTLP_FILE = 'otlp://grok'

export const grokProvider: Provider = {
  id: 'grok',
  name: 'Grok',
  root: grokHome,
  installed: () => existsSync(grokHome()),
  discover: (): UsageSource[] => [],
  parse: () => null,
  retention: 'all',
  otlp: true,
  setup: setupGrok,
}

export function grokOtlpFile(state: State): FileState {
  const existing = state.files[GROK_OTLP_FILE]
  if (existing !== undefined) {
    if (existing.series === undefined) existing.series = {}
    return existing
  }
  const created: FileState = { offset: 0, size: 0, series: {} }
  state.files[GROK_OTLP_FILE] = created
  return created
}
