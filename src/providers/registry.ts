import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import { copilotProvider } from './copilot.js'
import type { Provider } from './types.js'

/**
 * Every tool this build can read usage from.
 *
 * A tool only belongs here once its on-disk format has been verified against real data. Guessing a
 * format produces numbers that look plausible and are wrong, which is the one failure this tool
 * exists to prevent. Tools deliberately absent, and why:
 *
 *   - OpenCode: no token fields in `~/.local/share/opencode/storage`, `~/.local/state/opencode`,
 *     or the desktop app's data.
 *   - Antigravity: state is protobuf (`.pb` / `.pbtxt`) with no published schema.
 *   - Cursor: usage accounting is server-side; the local `state.vscdb` holds chat, not tokens.
 *   - Goose, Gemini CLI: only auth tokens on disk, no usage records.
 *
 * See `docs/PROVIDERS.md` for what a new provider has to supply.
 */
export const PROVIDERS: Provider[] = [claudeProvider, codexProvider, copilotProvider]

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

/** Providers whose data directory exists on this machine. */
export function installedProviders(): Provider[] {
  return PROVIDERS.filter((provider) => provider.installed())
}

/** `provider/model`, the key form used in every bucket. */
export function qualify(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

/**
 * Canonical form of a bucket key.
 *
 * State written before multi-provider support used bare model ids, and those buckets still exist
 * alongside qualified ones for the same model. Normalising at read time merges the two without
 * rewriting the ledger, which is append-only by design.
 */
export function normalizeKey(key: string): string {
  const { provider, model } = unqualify(key)
  return qualify(provider, model)
}

/**
 * Split a bucket key back into provider and model.
 *
 * Keys written before multi-provider support carry a bare model id; those are all Claude Code, so
 * an unqualified key resolves to that provider rather than being discarded.
 */
export function unqualify(key: string): { provider: string; model: string } {
  const slash = key.indexOf('/')
  if (slash === -1) return { provider: claudeProvider.id, model: key }
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
}
