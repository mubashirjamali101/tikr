import type { Server } from 'node:http'
import { commit, recoverFromLedger } from '../core/commit.js'
import { scanAll } from '../core/scan.js'
import { describeReset, loadState } from '../core/state.js'
import type { State } from '../core/types.js'
import { watchTranscripts } from '../core/watch.js'
import { clearPid, readPid, writePid } from '../daemon/lock.js'
import type { OtelSample } from '../otlp/parse.js'
import { DEFAULT_OTLP_PORT, applySamples, startOtlpReceiver } from '../otlp/receiver.js'
import { type Args, flagBool, flagInt } from '../util/args.js'

export const DEFAULT_INTERVAL_SECONDS = 15

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

/**
 * The background service.
 *
 * Three things drive it, all feeding the same state file:
 *   - a filesystem watch on the transcripts, so a new message is picked up within about a second
 *   - a periodic scan, which is both the Linux fallback (no recursive watch there) and a safety net
 *     for any change the watcher misses
 *   - optionally an OTLP receiver, for push-based telemetry straight from Claude Code
 */
export async function runDaemon(args: Args): Promise<number> {
  const intervalSeconds = flagInt(args, 'interval', DEFAULT_INTERVAL_SECONDS)
  const otlpEnabled = flagBool(args, 'otlp')
  const otlpPort = flagInt(args, 'otlp-port', DEFAULT_OTLP_PORT)

  const existing = readPid()
  if (existing !== null && existing !== process.pid) {
    log(`another service is already running (pid ${existing}); exiting`)
    return 0
  }
  writePid(process.pid)

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    log(`received ${signal}; shutting down`)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  // Serialise every state mutation through one queue. The watcher, the timer, and the OTLP
  // receiver all fire independently, and two concurrent read-modify-write cycles would lose data.
  let working = false
  let pending = false
  const withState = (
    source: 'transcript' | 'telemetry',
    mutate: (state: State) => string | null,
  ): void => {
    if (working) {
      pending = true
      return
    }
    working = true
    try {
      const { state, reset } = loadState()
      const resetReason = describeReset(reset)
      if (resetReason !== null) log(`starting a fresh record: ${resetReason}`)
      let message: string | null = null
      commit(state, source, (draft) => {
        message = mutate(draft)
      })
      if (message !== null) log(message)
    } catch (error) {
      log(`update failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      working = false
      if (pending) {
        pending = false
        withState(source, mutate)
      }
    }
  }

  const scan = (trigger: string): void => {
    withState('transcript', (state) => {
      const result = scanAll(state)
      if (result.messages === 0 && result.resyncs === 0) return null
      return `[${trigger}] ${result.messages} new messages, ${result.filesChanged} files, ${result.resyncs} resyncs`
    })
  }

  let receiver: Server | null = null
  if (otlpEnabled) {
    const onSamples = (samples: OtelSample[]): void => {
      if (samples.length === 0) return
      withState('telemetry', (state) => {
        const applied = applySamples(state.otel, samples)
        return applied > 0 ? `[otlp] ${applied} samples` : null
      })
    }
    receiver = startOtlpReceiver({
      port: otlpPort,
      onSamples,
      onError: (message) => log(`otlp: ${message}`),
    })
    log(`otlp receiver listening on 127.0.0.1:${otlpPort}`)
  }

  const watcher = watchTranscripts(() => scan('watch'))
  log(
    `service started (pid ${process.pid}, ${watcher === null ? 'polling only' : 'watching'}, ` +
      `interval ${intervalSeconds}s)`,
  )

  // If the cache is behind the ledger - a crash between the two writes, or a lost state file -
  // restore it before counting anything new.
  const recovery = recoverFromLedger()
  if (recovery.rebuilt) log(`rebuilt cache from ${recovery.entries} ledger entries`)

  scan('startup')
  try {
    while (!stopping) {
      await sleep(intervalSeconds * 1000, () => stopping)
      if (!stopping) scan('poll')
    }
  } finally {
    watcher?.close()
    receiver?.close()
    clearPid()
    log('service stopped')
  }
  return 0
}

/** Sleep in short slices so a stop signal is honoured promptly instead of after a full interval. */
async function sleep(totalMs: number, shouldStop: () => boolean): Promise<void> {
  const sliceMs = 250
  let elapsed = 0
  while (elapsed < totalMs && !shouldStop()) {
    const wait = Math.min(sliceMs, totalMs - elapsed)
    await new Promise((resolve) => setTimeout(resolve, wait))
    elapsed += wait
  }
}
