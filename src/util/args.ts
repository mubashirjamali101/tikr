export interface Args {
  command: string
  flags: Map<string, string | true>
  positional: string[]
}

/**
 * Minimal flag parser: `--name value`, `--name=value`, and bare `--name` booleans.
 *
 * Hand-rolled because the tool ships with zero runtime dependencies, and its flag surface is small
 * enough that a parser library would be the largest thing in the install.
 */
export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  let command = ''

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      if (command === '') command = arg
      else positional.push(arg)
      continue
    }

    const body = arg.slice(2)
    const equals = body.indexOf('=')
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next)
      index += 1
    } else {
      flags.set(body, true)
    }
  }

  return { command, flags, positional }
}

export function flagString(args: Args, name: string): string | null {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : null
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags.has(name)
}

/**
 * Read an integer flag, falling back when absent or out of range.
 *
 * `min` defaults to 1 because most numeric flags here are intervals and ports, where zero is
 * meaningless. It has to be overridable: `--days 0` means "all history", and treating that as
 * invalid silently truncated the report to the default window.
 */
export function flagInt(args: Args, name: string, fallback: number, min = 1): number {
  const raw = flagString(args, name)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= min ? value : fallback
}
