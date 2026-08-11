export type Key =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'tab'
  | 'shift-tab'
  | 'enter'
  | 'escape'
  | 'quit'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | { char: string }

const ESC = '\x1b'

const SEQUENCES: Record<string, Key> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[1~': 'home',
  '\x1b[F': 'end',
  '\x1b[4~': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[Z': 'shift-tab',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
}

/**
 * Decode one raw-mode chunk into a key.
 *
 * Raw mode delivers escape sequences as bytes, so an arrow arrives as `ESC [ A` rather than as an
 * event, and Ctrl-C arrives as `0x03` instead of raising SIGINT. Only the sequences this app binds
 * are decoded; an unrecognised escape sequence is dropped whole rather than being mistaken for the
 * individual characters that make it up.
 */
export function decodeKey(data: Buffer): Key | null {
  const text = data.toString('utf8')

  if (text === '\x03' || text === '\x04') return 'quit'
  if (text === '\r' || text === '\n') return 'enter'
  if (text === '\t') return 'tab'
  if (text === ESC) return 'escape'

  const known = SEQUENCES[text]
  if (known !== undefined) return known

  if (text.startsWith(ESC)) return null
  if (text.length !== 1) return null
  return { char: text }
}

export function isChar(key: Key, ...chars: string[]): boolean {
  return typeof key === 'object' && chars.includes(key.char.toLowerCase())
}
