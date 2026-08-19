/**
 * Tiny TOML table editor. Only `[section]` tables of `key = value` lines; enough to merge
 * provider setup keys without a parser dependency.
 */

const TABLE = /^\[([^\]]+)\]\s*$/
const KEY = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/

export function tomlTable(raw: string, table: string): Record<string, string> {
  const out: Record<string, string> = {}
  const { start, end, lines } = bounds(raw, table)
  if (start === -1) return out
  for (const line of lines.slice(start + 1, end)) {
    const match = KEY.exec(line)
    if (match === null) continue
    out[match[1]!] = unquote(match[2]!)
  }
  return out
}

/** Set or replace keys in `[table]`, leaving comments and unknown keys alone. */
export function upsertTomlTable(
  raw: string,
  table: string,
  values: Record<string, string>,
): string {
  const normalised = raw.replaceAll('\r\n', '\n')
  const { start, end, lines } = bounds(normalised, table)
  if (start === -1) {
    const prefix = normalised.trimEnd()
    const assignments = Object.entries(values).map(([key, value]) => `${key} = ${value}`)
    const block = `[${table}]\n${assignments.join('\n')}\n`
    return prefix.length === 0 ? block : `${prefix}\n\n${block}`
  }

  const remaining = new Map(Object.entries(values))
  const section: string[] = []
  for (const line of lines.slice(start + 1, end)) {
    const match = KEY.exec(line)
    if (match !== null && remaining.has(match[1]!)) {
      section.push(`${match[1]} = ${remaining.get(match[1]!)}`)
      remaining.delete(match[1]!)
    } else {
      section.push(line)
    }
  }
  const extra = [...remaining.entries()].map(([key, value]) => `${key} = ${value}`)
  const insertAt = trailingBlanks(section)
  section.splice(insertAt, 0, ...extra)
  const next = [...lines.slice(0, start + 1), ...section, ...lines.slice(end)]
  let text = next.join('\n')
  if (!text.endsWith('\n')) text += '\n'
  return text
}

function bounds(raw: string, table: string): { start: number; end: number; lines: string[] } {
  const lines = raw.split('\n')
  let start = -1
  let end = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const match = TABLE.exec(lines[index]!)
    if (match === null) continue
    if (match[1] === table) {
      start = index
      continue
    }
    if (start !== -1) {
      end = index
      break
    }
  }
  return { start, end, lines }
}

function trailingBlanks(lines: string[]): number {
  let index = lines.length
  while (index > 0 && lines[index - 1] === '') index -= 1
  return index
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
