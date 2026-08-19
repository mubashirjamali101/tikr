import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { drainPendingCopilot } from '../providers/copilot.js'
import type { Provider } from '../providers/types.js'
import { apply } from './fold.js'
import { recordLimitEvent } from './limits.js'
import type { FileState, State } from './types.js'

export interface ProviderScan {
  files: number
  messages: number
}

export interface IngestResult {
  filesSeen: number
  filesChanged: number
  bytesRead: number
  messages: number
  resyncs: number
  /** Usage limit events newly recorded this pass. */
  limitEvents: number
  /** Per-provider file and message counts from this pass. */
  byProvider: Record<string, ProviderScan>
}

export function emptyResult(): IngestResult {
  return {
    filesSeen: 0,
    filesChanged: 0,
    bytesRead: 0,
    messages: 0,
    resyncs: 0,
    limitEvents: 0,
    byProvider: {},
  }
}

export function tallyProvider(
  result: IngestResult,
  id: string,
  files: number,
  messages: number,
): void {
  const bucket = result.byProvider[id] ?? { files: 0, messages: 0 }
  bucket.files += files
  bucket.messages += messages
  result.byProvider[id] = bucket
}

/** Read `length` bytes starting at `start`. Every provider's files are UTF-8 JSONL. */
function readRange(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled)
      if (read <= 0) break
      filled += read
    }
    return buffer.subarray(0, filled).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Ingest whatever has been appended to one file since the last pass.
 *
 * Files are append-only while a session is live, so tracking a byte offset means a scan costs one
 * stat plus the size of the new tail, not a re-read.
 */
export function ingestFile(
  state: State,
  provider: Provider,
  path: string,
  project: string,
  result: IngestResult,
): void {
  result.filesSeen += 1

  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }

  let file: FileState = state.files[path] ?? { offset: 0, size: 0, series: {} }
  if (file.series === undefined) file.series = {}

  if (size < file.offset) {
    // The file shrank, so it was rewritten rather than appended to. Re-reading from zero would
    // double-count everything already recorded, and the tokens cannot be subtracted because they
    // are spread across many day and project buckets. Resync and accept the gap.
    state.files[path] = { offset: size, size, series: {} }
    state.resyncs += 1
    result.resyncs += 1
    return
  }

  if (size === file.offset) {
    state.files[path] = { ...file, size }
    return
  }

  const chunk = readRange(path, file.offset, size - file.offset)
  // A live session may be mid-write, leaving an incomplete final line. Stop at the last newline
  // and leave the remainder for the next pass rather than parsing a truncated object.
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) {
    state.files[path] = { ...file, size }
    return
  }

  const complete = chunk.slice(0, lastNewline)
  for (const line of complete.split('\n')) {
    // Facts that are not usage: a refused request records the limit it hit. Carries no tokens, so
    // it is recorded before the usage check rather than competing with it.
    const signal = provider.parseSignal?.(line) ?? null
    if (signal !== null && signal.kind === 'limit') {
      if (recordLimitEvent(state.limits, signal.event)) result.limitEvents += 1
    }

    const observation = provider.parse(line, path)
    if (observation === null) continue
    if (apply(state, provider, project, file, observation)) result.messages += 1
    // A single Copilot line reports every model at once; the extras queue up behind the first.
    for (const extra of drainPendingCopilot(path)) {
      if (apply(state, provider, project, file, extra)) result.messages += 1
    }
  }

  file = {
    offset: file.offset + Buffer.byteLength(complete, 'utf8') + 1,
    size,
    series: file.series,
  }
  state.files[path] = file
  result.filesChanged += 1
  result.bytesRead += lastNewline + 1
}
