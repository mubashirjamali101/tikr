import { commit } from '../core/commit.js'
import { scanAll } from '../core/scan.js'
import { loadState } from '../core/state.js'
import { watchTranscripts } from '../core/watch.js'
import { readPid } from '../daemon/lock.js'
import { type Key, decodeKey, isChar } from './keys.js'
import { type Snapshot, snapshot } from './model.js'
import { TABS, type ViewState, renderFrame, rowCount } from './render.js'
import { enterScreen, onResize, paint, restoreScreen, terminalSize } from './screen.js'
import { nextSort } from './sort.js'

const WINDOWS = [7, 30, 90, 0]

/**
 * The interactive view.
 *
 * Repaints on three triggers: a keypress, a filesystem change from any tracked tool, and a slow
 * timer that keeps relative timestamps honest while idle. It never repaints on a fixed fast tick,
 * because a TUI that redraws when nothing changed burns battery for no benefit.
 */
export async function runApp(initialWindow: number, windowPinned = false): Promise<number> {
  const view: ViewState = {
    tab: 'overview',
    selected: 0,
    windowDays: initialWindow,
    scanning: false,
    serviceRunning: readPid() !== null,
    lastUpdate: new Date(),
    help: false,
    sort: 'tokens',
  }

  let snap: Snapshot = refresh()
  let dirty = true

  function refresh(): Snapshot {
    let { state } = loadState()
    // Scan when the daemon is down, and also when the record is empty: a first open should
    // consume existing Claude/Codex/Copilot history even if the service has not caught up.
    if (readPid() === null || Object.keys(state.daily).length === 0) {
      try {
        commit(state, 'transcript', (draft) => {
          scanAll(draft)
        })
      } catch {
        // A running service may already hold a larger record; show whatever is on disk.
      }
      state = loadState().state
    }
    view.serviceRunning = readPid() !== null
    view.lastUpdate = new Date()
    if (
      !windowPinned &&
      view.windowDays > 0 &&
      snapshot(state, view.windowDays).days.length === 0 &&
      Object.keys(state.daily).length > 0
    ) {
      view.windowDays = 0
    }
    return snapshot(state, view.windowDays)
  }

  function clampSelection(): void {
    const rows = rowCount(snap, view.tab)
    if (rows === 0) view.selected = 0
    else view.selected = Math.max(0, Math.min(rows - 1, view.selected))
  }

  function draw(): void {
    if (!dirty) return
    dirty = false
    clampSelection()
    paint(renderFrame(snap, view, terminalSize()), terminalSize())
  }

  enterScreen()
  const stopResize = onResize(() => {
    dirty = true
    draw()
  })
  const watcher = watchTranscripts(() => {
    snap = refresh()
    dirty = true
    draw()
  }, 400)

  let running = true
  const onKey = (data: Buffer): void => {
    const key = decodeKey(data)
    if (key === null) return
    if (handleKey(key)) {
      dirty = true
      draw()
    }
  }

  function handleKey(key: Key): boolean {
    if (key === 'quit' || isChar(key, 'q')) {
      running = false
      return false
    }
    if (isChar(key, '?')) {
      view.help = !view.help
      return true
    }
    if (view.help && (key === 'escape' || key === 'enter')) {
      view.help = false
      return true
    }

    if (key === 'tab' || isChar(key, 'l') || key === 'right') return cycleTab(1)
    if (key === 'shift-tab' || isChar(key, 'h') || key === 'left') return cycleTab(-1)

    if (typeof key === 'object' && /^[1-4]$/.test(key.char)) {
      view.tab = TABS[Number(key.char) - 1] ?? view.tab
      view.selected = 0
      return true
    }

    if (key === 'down' || isChar(key, 'j')) return move(1)
    if (key === 'up' || isChar(key, 'k')) return move(-1)
    if (key === 'pagedown') return move(10)
    if (key === 'pageup') return move(-10)
    if (key === 'home' || isChar(key, 'g')) {
      view.selected = 0
      return true
    }
    if (key === 'end' || (typeof key === 'object' && key.char === 'G')) {
      view.selected = Math.max(0, rowCount(snap, view.tab) - 1)
      return true
    }

    if (isChar(key, 'd')) {
      const index = WINDOWS.indexOf(view.windowDays)
      view.windowDays = WINDOWS[(index + 1) % WINDOWS.length] ?? 30
      snap = refresh()
      return true
    }
    if (isChar(key, 's')) {
      view.sort = nextSort(view.sort)
      // The row under the cursor moves when the order changes, so start from the top rather than
      // leaving the highlight on an unrelated row.
      view.selected = 0
      return true
    }
    if (isChar(key, 'r')) {
      view.scanning = true
      draw()
      snap = refresh()
      view.scanning = false
      return true
    }
    return false
  }

  function cycleTab(direction: number): boolean {
    const index = TABS.indexOf(view.tab)
    view.tab = TABS[(index + direction + TABS.length) % TABS.length] ?? view.tab
    view.selected = 0
    return true
  }

  function move(delta: number): boolean {
    view.selected += delta
    return true
  }

  process.stdin.on('data', onKey)
  draw()

  // Idle refresh: slow enough to be invisible, frequent enough that "updated 3m ago" is not a lie.
  const timer = setInterval(() => {
    snap = refresh()
    dirty = true
    draw()
  }, 30_000)

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  clearInterval(timer)
  process.stdin.off('data', onKey)
  watcher?.close()
  stopResize()
  restoreScreen()
  return 0
}
