# Providers

A provider teaches the tool to read one AI coding tool's local usage records. Everything else -
storage, encryption, the ledger, reporting, pricing - is shared.

## The rule for adding one

**Verify the on-disk format against a real installation before writing any code.** A parser written
from a guess produces numbers that look plausible and are wrong, which is the single failure this
tool exists to prevent. If the format cannot be checked against real data, the tool does not get a
provider; it gets an entry in the "not trackable" list in `src/commands/providers.ts` with the
reason.

## What was investigated

Checked against real installations on 2026-08-11.

| Tool | Location | Usage on disk | Provider |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `message.usage` per assistant entry | ✅ |
| Codex | `~/.codex/{sessions,archived_sessions}/**/*.jsonl` | `token_count` events | ✅ |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` | `modelMetrics` per event | ✅ |
| OpenCode | `~/.local/share/opencode`, `~/.local/state/opencode` | none found | ❌ |
| Antigravity | `~/.gemini/antigravity`, `~/Library/Application Support/Antigravity` | protobuf, no schema | ❌ |
| Cursor | `~/.cursor`, `Application Support/Cursor/**/state.vscdb` | none; accounted server-side | ❌ |
| Goose | `~/.config/goose` | auth tokens only | ❌ |
| Gemini CLI | `~/.gemini` | auth tokens only | ❌ |

For the three that work, the exact record shapes are in the file header comment of each provider.

## The one abstraction that matters

**Every provider reports running totals for some series, and the fold adds only the increase.** That
single rule covers all three shapes seen so far, and it is why the code has no per-provider counting
logic:

| Tool | A series is | Reported as |
|---|---|---|
| Claude Code | one `message.id` | repeated per content block, growing while streaming |
| Codex | the session | `total_token_usage`, cumulative and monotonic |
| Copilot | one model within a session | `modelMetrics`, restated on every event |

Taking the maximum per field and adding the difference is idempotent: re-reading a line changes
nothing, and a later, larger snapshot self-corrects.

## Writing one

Implement `Provider` from `src/providers/types.ts` and add it to `PROVIDERS` in
`src/providers/registry.ts`.

```ts
export const myProvider: Provider = {
  id: 'my-tool',                 // becomes the `my-tool/<model>` namespace
  name: 'My Tool',
  root: () => join(homedir(), '.my-tool'),
  installed: () => existsSync(root()),
  discover: () => [...],         // the append-only files to read
  parse: (line, fileKey) => ..., // one UsageObservation, or null
  parseSignal: (line) => ...,    // optional: facts that are not usage, such as hitting a limit
  retention: 'all',              // or 'last-only', see below
}
```

Points that are easy to get wrong:

- **`retention`.** Use `last-only` when the tool mints a new series per message and repeats are
  consecutive, so remembering every one would grow without bound. Use `all` for a small fixed set
  (one per session, or one per model).
- **`countMode`.** `cumulative` when the record carries a running request count, so it can be
  differenced like any other field. `per-growth` when it does not, in which case one is added each
  time the totals actually move.
- **Cached input is usually a subset, not an addition.** Codex's `cached_input_tokens` is the cached
  part *of* `input_tokens`; subtract it and book it as a cache read so it is priced at the cache
  rate.
- **Every observation carries `day`, `hour` and `at`.** The hour bucket is what the five-hour block
  model, the burn rate and the heatmap are derived from, and `at` is what tells the active block how
  long ago the last message was. All three are local-time derivations of the record's own timestamp,
  so a provider whose records lack a timestamp cannot be supported.
- **Price-affecting properties become model suffixes**, in the fixed order `<model>[-fast][-long]`.
  That is how the same model billed two ways stays in two buckets. Only apply `-long` when the model
  publishes a long-context tier (`longContextThreshold`), and never invent a suffix of your own
  without extending `parseModelKey`.
- **`parseSignal` carries no tokens.** It exists for facts like a usage limit being hit. If your
  signal has usage attached, it belongs in `parse`.
- **`root()` must return a path even when the tool is absent.** It is used for the filesystem watch
  and in `providers` output.
- **Provide an env override for the data directory** (`CODEX_HOME`, `COPILOT_HOME`). Without one,
  tests read the developer's real data and assertions drift with their actual usage.

## Pricing

Rates live in `src/core/rates.generated.ts`, generated from LiteLLM's public price table by
`scripts/generate-rates.mjs` (`pnpm run rates`) and committed so the tool stays offline. Never
hand-edit that file: corrections go in `OVERRIDES` in `src/core/rates.ts`, which wins over the
generated table, and rates that change on a known date go in `DATED`.

`src/core/pricing.ts` turns a bucket key into a cost and a **basis**: `exact` (published rate for
that model), `family` (model absent, family rate used), or `partial` (a surcharge that applies could
not be included, which today means fast mode without a published multiplier). Anything absent falls
back to the family rather than being silently priced at zero, and the report always names the
weakest basis present.
