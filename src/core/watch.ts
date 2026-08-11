import { type FSWatcher, watch } from 'node:fs'
import { PROVIDERS } from '../providers/registry.js'

export interface Watcher {
  close: () => void
  /** How many provider roots are being watched. Zero means the poll interval is doing the work. */
  watching: number
}

/**
 * Call `onChange` shortly after any tracked tool writes usage.
 *
 * Every installed provider's root gets its own watch, so Codex and Copilot are as immediate as
 * Claude Code. Tools append usage within a second or two, so watching turns a fixed poll interval
 * into near-instant detection.
 *
 * Events are debounced because one message produces several writes in quick succession, and a scan
 * is cheap but not free. macOS and Windows support recursive directory watching; Linux does not, so
 * there the caller's polling interval remains the mechanism.
 */
export function watchTranscripts(onChange: () => void, debounceMs = 400): Watcher | null {
  let timer: NodeJS.Timeout | null = null

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  const watchers: FSWatcher[] = []
  for (const provider of PROVIDERS) {
    if (!provider.installed()) continue
    try {
      const watcher = watch(provider.root(), { recursive: true }, schedule)
      // A watch error (the directory is removed, or the descriptor limit is hit) must not take the
      // service down; the periodic scan keeps working regardless.
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {
      // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on Linux, or the directory does not exist yet.
    }
  }

  if (watchers.length === 0) return null

  return {
    watching: watchers.length,
    close: () => {
      if (timer !== null) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}
