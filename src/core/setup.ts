import { PROVIDERS, unqualify } from '../providers/registry.js'
import type { Provider } from '../providers/types.js'
import type { Args } from '../util/args.js'
import { flagBool } from '../util/args.js'
import { type IngestResult, type ProviderScan, emptyResult } from './ingest.js'
import type { State } from './types.js'

function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function recordedMessages(state: State, providerId: string): number {
  let messages = 0
  for (const byModel of Object.values(state.daily)) {
    for (const [model, totals] of Object.entries(byModel)) {
      if (unqualify(model).provider === providerId) messages += totals.messages
    }
  }
  return messages
}

function describeProvider(
  provider: Provider,
  setup: string | null,
  scanned: ProviderScan | undefined,
  seedOnly: boolean,
  state: State | null,
): string {
  if (provider.otlp === true) {
    const live = setup ?? 'live OTLP feed (session files have no token counts to backfill)'
    if (state === null) return live
    const messages = recordedMessages(state, provider.id)
    return messages > 0
      ? `${live}; ${counted(messages, 'message')} recorded so far`
      : `${live}; counting from now`
  }
  const files = state !== null ? provider.discover().length : (scanned?.files ?? 0)
  const messages =
    state !== null && !seedOnly ? recordedMessages(state, provider.id) : (scanned?.messages ?? 0)
  const history = seedOnly
    ? `${counted(files, 'file')} marked; counting from now`
    : `${counted(files, 'file')}, ${counted(messages, 'message')} from existing history`
  return setup === null ? history : `${history}; ${setup}`
}

/**
 * Configure every installed tool and describe what was found, including the backfill from this
 * scan. File-backed tools are the existing session files; OTLP-only tools (Grok) cannot be
 * backfilled.
 */
export function setupInstalled(
  otlpPort: number,
  result: IngestResult = emptyResult(),
  seedOnly = false,
  configure = true,
  state: State | null = null,
): string[] {
  const lines: string[] = []
  for (const provider of PROVIDERS) {
    if (!provider.installed()) continue
    const setup = configure ? (provider.setup?.({ otlpPort }) ?? null) : null
    lines.push(
      `${provider.name}: ${describeProvider(provider, setup, result.byProvider[provider.id], seedOnly, state)}`,
    )
  }
  return lines
}

export function installedNeedOtlp(): boolean {
  return PROVIDERS.some((provider) => provider.installed() && provider.otlp === true)
}

/**
 * `--no-otlp` wins, then an explicit `--otlp`, then "any installed tool needs the receiver".
 * File-backed tools work without it; Grok does not.
 */
export function wantOtlp(args: Args): boolean {
  if (flagBool(args, 'no-otlp')) return false
  if (flagBool(args, 'otlp')) return true
  return installedNeedOtlp()
}
