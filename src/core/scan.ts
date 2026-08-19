import { statSync } from 'node:fs'
import { PROVIDERS } from '../providers/registry.js'
import type { Provider } from '../providers/types.js'
import { type IngestResult, emptyResult, ingestFile, tallyProvider } from './ingest.js'
import type { State } from './types.js'

export interface TranscriptFile {
  path: string
  project: string
  provider: Provider
}

/** Every file every installed provider can currently read. */
export function listTranscripts(): TranscriptFile[] {
  const out: TranscriptFile[] = []
  for (const provider of PROVIDERS) {
    if (!provider.installed()) continue
    for (const source of provider.discover()) {
      out.push({ path: source.path, project: source.project, provider })
    }
  }
  return out
}

/**
 * Record how many already-counted files have disappeared.
 *
 * Claude Code deletes session files older than `cleanupPeriodDays` (30 by default) at startup, and
 * other tools prune too. The tokens stay counted; tracking the deletions turns "my history is
 * quietly evaporating" into something the tool can state outright.
 */
function trackPruned(state: State, present: Set<string>): void {
  let missing = 0
  for (const path of Object.keys(state.files)) {
    if (!present.has(path)) missing += 1
  }
  if (missing > state.pruned.count) state.pruned.lastAt = new Date().toISOString()
  state.pruned.count = missing
}

export interface ScanOptions {
  /**
   * Record where each new file currently ends without reading it, so counting starts from now.
   * Files already being tracked are unaffected.
   */
  seedOnly?: boolean
}

export function scanAll(state: State, options: ScanOptions = {}): IngestResult {
  const result = emptyResult()
  const present = new Set<string>()

  for (const file of listTranscripts()) {
    present.add(file.path)
    if (options.seedOnly === true && state.files[file.path] === undefined) {
      let size = 0
      try {
        size = statSync(file.path).size
      } catch {
        continue
      }
      state.files[file.path] = { offset: size, size, series: {} }
      result.filesSeen += 1
      tallyProvider(result, file.provider.id, 1, 0)
      continue
    }
    const filesBefore = result.filesSeen
    const messagesBefore = result.messages
    ingestFile(state, file.provider, file.path, file.project, result)
    tallyProvider(
      result,
      file.provider.id,
      result.filesSeen - filesBefore,
      result.messages - messagesBefore,
    )
  }

  trackPruned(state, present)
  state.lastScanAt = new Date().toISOString()
  return result
}
