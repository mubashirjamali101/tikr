import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Args } from '../util/args.js'
import { counterHome } from './paths.js'

/**
 * Optional configuration, `~/.tikr/config.json`.
 *
 * Lowest precedence: a CLI flag always wins, then the command block, then the defaults block. Only
 * options that already exist as flags may appear here - a setting with no flag is a feature nobody
 * asked for. Contains no usage data and no secrets, so unlike the state file it is plain JSON.
 *
 * A malformed file is reported once and ignored. Refusing to run because a preference file has a
 * stray comma would be a poor trade for something entirely optional.
 */
export interface Config {
  defaults: Record<string, string | number | boolean>
  commands: Record<string, Record<string, string | number | boolean>>
  /** Encoded project key, or the shortened name, to the label reports should print. */
  projects: Record<string, string>
  /** Set when the file exists but could not be used. */
  problem: string | null
}

export function configPath(): string {
  return join(counterHome(), 'config.json')
}

export function emptyConfig(): Config {
  return { defaults: {}, commands: {}, projects: {}, problem: null }
}

function record(value: unknown): Record<string, never> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, never>)
    : null
}

let cached: Config | null = null

export function loadConfig(force = false): Config {
  if (cached !== null && !force) return cached

  let raw: string
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch {
    cached = emptyConfig()
    return cached
  }

  const config = emptyConfig()
  try {
    const parsed = record(JSON.parse(raw))
    if (parsed === null) throw new Error('not an object')
    config.defaults = record(parsed.defaults) ?? {}
    config.commands = record(parsed.commands) ?? {}
    config.projects = record(parsed.projects) ?? {}
  } catch (error) {
    config.problem = `${configPath()} could not be read (${(error as Error).message})`
  }
  cached = config
  return config
}

/** Configured value for one option, command block first. Returns null when unset. */
export function configValue(
  config: Config,
  command: string,
  name: string,
): string | number | boolean | null {
  const scoped = config.commands[command]?.[name]
  if (scoped !== undefined) return scoped
  return config.defaults[name] ?? null
}

/**
 * Fill in unset flags from the configuration file.
 *
 * Applied once at the start of a command, which keeps every `flagString`/`flagInt` call site
 * unchanged and makes the precedence rule impossible to get wrong: whatever the user typed is
 * already in the map, so only the gaps are filled.
 */
export function applyConfig(args: Args, command: string, config: Config = loadConfig()): void {
  const keys = new Set([
    ...Object.keys(config.defaults),
    ...Object.keys(config.commands[command] ?? {}),
  ])
  for (const key of keys) {
    if (args.flags.has(key)) continue
    const value = configValue(config, command, key)
    if (value === null) continue
    // A boolean flag is read by presence, so `false` must leave the flag absent. Storing it as the
    // string "false" would have switched the option on, which is the opposite of what was written.
    if (value === false) continue
    args.flags.set(key, value === true ? true : String(value))
  }
}
