# Phase 02: a pricing engine that is generated, tiered, and honest about provenance

**Problem.** Rates are a hand-maintained literal in `src/core/pricing.ts`. It drifts (the Sonnet 5
promotional window is already a known TODO), it has no long-context tier, and every number it
produces is presented the same way whether it came from an exact published rate, a family guess, or
Claude Code's own telemetry.

## 02a. Generated rate table

**Verified elsewhere:** ccusage embeds LiteLLM's table at build time plus a models.dev snapshot as a
second fallback, fetching only when not in offline mode. We take the embedded half and drop the
fetch: this tool does not open sockets.

- `scripts/generate-rates.ts`, run by a developer, never at install or run time. Fetches LiteLLM
  `model_prices_and_context_window.json` and `models.dev/api.json`, filters to the providers we
  read, and writes `src/core/rates.generated.ts`.
- The generated file is committed and never hand-edited (`docs/CONTRIBUTING.md`, migrations rule applies by
  analogy). It carries a header with the source URLs and the date fetched.
- `src/core/rates.ts` holds overrides and the family fallbacks, and wins over the generated table so
  a wrong upstream value can be corrected without editing generated output.
- `pnpm run rates` regenerates; a test asserts the committed file parses and covers every model id
  we have ever recorded in local state, so a missing model fails CI rather than being priced by
  family in silence.

Effect on `docs/TODOs.md`: the Sonnet 5 promo item becomes a date-bounded override entry
(`{ from, until, rate }`) in `rates.ts`, checked against the bucket's day. Daily buckets already
carry the day, so this needs no new data.

## 02b. Long-context tiers

**Verified elsewhere:** `Pricing` carries `input_above_200k` / `output_above_200k` and a per-model
`long_context_threshold`. The tier is chosen **per request** by input size, then applies to every
bucket of that request including cache. It is not a marginal breakpoint. Anthropic switches above
200K, OpenAI above 272K.

We aggregate per day and per model, so the request is gone by the time we price. Two options:

1. **Reject:** price the whole daily bucket at the tier its total implies. Wrong by construction:
   a day of small requests would be billed at the long-context rate.
2. **Adopt:** decide the tier at ingest, where the request is still visible, and route the usage
   into a `-long` model bucket. Cost then reads the tier off the bucket name.

Take option 2. It mirrors phase 01 exactly, so there is one mechanism for "same model, different
price", not two. Context size for the decision is `input + cacheRead + cacheWrite5m + cacheWrite1h`,
which is what the model actually saw. Verify against real transcripts before wiring: count how many
messages exceed 200K by that measure, and record the number in this file. If it is zero on this
machine, the code still ships, but flagged unverified.

Bucket names compose in a fixed order so they never permute: `<model>[-fast][-long]`.

## 02c. Cost provenance

Every reported cost gets a source, and the report says which:

| Source | Meaning |
|---|---|
| `reported` | Claude Code's own telemetry figure. Not an estimate |
| `exact` | Computed from a published rate for that exact model id |
| `family` | Computed from a family fallback, model id not in the table |
| `partial` | Computed, but a known surcharge could not be applied (fast mode, phase 01) |

`estimateCost` returns `{ usd, basis }` instead of a bare number. `stats` prints one footer line
naming the weakest basis present, replacing today's separate unknown-model line. The telemetry
section keeps reporting `reported` figures separately and is still never summed with the estimate.

## Work

1. `src/core/rates.ts` (tables, overrides, family fallbacks, date-bounded entries).
2. `src/core/rates.generated.ts` (generated, committed).
3. `scripts/generate-rates.ts` plus a `rates` script in `package.json`.
4. `src/core/pricing.ts` shrinks to the cost calculation and basis reporting, staying well under
   200 lines once the tables move out.
5. `src/core/parse.ts` computes context size; `src/providers/claude.ts` appends `-long`.
6. `src/commands/stats.ts`, `src/tui/*`, `src/report/render.ts` render the basis.

## Tests

- Generated table parses, and covers every model id present in a fixture state.
- Override beats generated; date-bounded override applies inside its window and not outside.
- Long-context: a request over the threshold prices every bucket at the tier rate, a day made of
  small requests does not.
- Basis: telemetry-backed model reports `reported`; unknown model reports `family`; fast without a
  multiplier reports `partial`.
- `(bug)` case: the Sonnet 5 promo window now prices below the standard rate inside the window.

## Risks

- **Upstream tables are not authoritative for Anthropic.** Treat LiteLLM as a starting point, keep
  the hand-verified Anthropic rates as overrides. `docs/LESSONS.md` records that the current table
  reconciles with Claude Code's own cost figure to $0.00 once the cache TTL split is supplied. That
  reconciliation is the acceptance test for any table change and must be re-run after regeneration.
- **Bucket name explosion.** Three optional suffixes would be eight buckets per model. Two is the
  cap; anything further needs a real dimension on `Totals`, not another suffix.
