import { PROVIDERS } from '../providers/registry.js'
import type { Args } from '../util/args.js'
import { flagBool } from '../util/args.js'

/** Configure every supported tool that is installed on this machine. */
export function setupInstalled(otlpPort: number): string[] {
  const lines: string[] = []
  for (const provider of PROVIDERS) {
    if (!provider.installed()) continue
    const detail = provider.setup?.({ otlpPort }) ?? `watching ${provider.root()}`
    lines.push(`${provider.name}: ${detail}`)
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
