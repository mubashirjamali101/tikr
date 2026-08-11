/**
 * Colour and text helpers.
 *
 * Colour is disabled when `NO_COLOR` is set or stdout is not a terminal, and every helper is a
 * no-op in that case, so the same render code produces clean plain text when piped.
 */
const enabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true

function wrap(code: string): (text: string) => string {
  return (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text)
}

export const bold = wrap('1')
export const dim = wrap('2')
export const inverse = wrap('7')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('34')
export const magenta = wrap('35')
export const cyan = wrap('36')
export const grey = wrap('90')

/** A stable colour per tool, so a provider keeps its identity across every view. */
const PROVIDER_COLOURS: Record<string, (text: string) => string> = {
  'claude-code': cyan,
  codex: green,
  copilot: magenta,
}

export function providerColour(id: string): (text: string) => string {
  return PROVIDER_COLOURS[id] ?? yellow
}

/** Length ignoring escape sequences, so padding maths stays correct on coloured text. */
export function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function padEnd(text: string, width: number): string {
  const pad = width - visibleLength(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

export function padStart(text: string, width: number): string {
  const pad = width - visibleLength(text)
  return pad > 0 ? ' '.repeat(pad) + text : text
}

/** Cut to width without slicing a colour sequence in half. */
export function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text
  let out = ''
  let visible = 0
  let index = 0
  while (index < text.length && visible < width - 1) {
    if (text[index] === '\x1b') {
      const end = text.indexOf('m', index)
      if (end === -1) break
      out += text.slice(index, end + 1)
      index = end + 1
      continue
    }
    out += text[index]
    visible += 1
    index += 1
  }
  return `${out}\x1b[0m…`
}
