# Phase 01: fast mode is a different price

**Problem.** Claude Code's fast mode is billed at a multiple of the standard rate. We ignore the
field entirely, so fast usage is reported at 1x. This is the only known case where the tool prints
a number that is wrong rather than incomplete, which makes it the first thing to fix.

**Verified here** (2026-08-11): the field is `message.usage.speed`, **inside** `usage` next to the
token counts, not beside it. Across every local transcript: 41,882 `standard`, 17 `null`, 1 `fast`.
The first implementation read `message.speed` and therefore never saw a fast message; the
regression test in `test/parse.test.ts` pins the real nesting. **Verified elsewhere** (ccusage
`fast-multiplier-overrides.json`): 6.0 for `claude-opus-4-6` and `-4-7`, 2.0 for `-4-8`, 2.0 to 2.5
across GPT-5.x. **Unverified**: the multiplier for `claude-opus-5`. It is absent from every public
table, so it must not be guessed.

## Design

Fast usage becomes its own model bucket, suffixed `-fast`, exactly as ccusage does:
`claude-code/claude-opus-5-fast`. Reasons this beats a boolean on `Totals`:

- Every aggregate, snapshot key, ledger delta and report path already keys on model, so the change
  is one string and no schema migration.
- The two rates never merge, so a later multiplier can be applied retroactively to the recorded
  split without re-reading anything.
- `stats --by model` shows the split for free, which is the report a user needs to decide whether
  fast mode is worth it.

Pricing looks up the base model with the suffix stripped, then applies `fastMultiplier` when known.
When it is not known, the cost is computed at the base rate and the model is added to the existing
"priced by family (no exact published rate)" footer, with wording that says the fast surcharge is
not included. Understating with a visible flag beats overstating with a guess.

## Work

1. `src/core/parse.ts`
   - Read `msg.speed`; accept only the literals `standard` and `fast`, anything else is `standard`.
   - `UsageRecord` gains `speed: 'standard' | 'fast'` (`src/core/types.ts`).
   - Watch the file size: parse.ts is 84 lines, the speed read and its comment fit.
2. `src/providers/claude.ts`
   - `parse()` appends `-fast` to `record.model` when `speed === 'fast'`. Nothing else changes;
     `qualify()` and the fold are untouched.
   - The series stays `messageId`. Speed is a property of the message, so it cannot change within a
     series, and the fold's max-per-field rule is unaffected.
3. `src/core/pricing.ts` (118 lines, near the limit: split the rate tables into
   `src/core/rates.ts` in this phase rather than after it)
   - `FAST_MULTIPLIERS: Record<string, number>`, seeded only with values that have a published
     source, each with a comment naming that source.
   - `rateFor()` strips a `-fast` suffix before lookup and returns `{ rate, exact, fastKnown }`.
   - `estimateCost()` multiplies by the known multiplier, or by 1 with `fastKnown: false`.
4. `src/commands/stats.ts` and `src/tui/*`
   - Footer line when any `-fast` bucket has usage and its multiplier is unknown: state that fast
     messages are counted and priced at the standard rate, and that the surcharge is unpublished.
   - No new sub-text anywhere else (`docs/CONTRIBUTING.md`).

## Tests

- `test/parse.test.ts`: `speed: "fast"`, `"standard"`, absent, and a junk value.
- `test/providers.test.ts`: two transcript lines differing only in `speed` produce two model
  buckets, and the totals are not merged.
- `test/pricing.test.ts`: unknown multiplier costs exactly the base rate and reports `fastKnown:
  false`; a known multiplier multiplies the whole bucket including cache terms; `-fast` on an
  unknown family still falls back to the family rate.
- `(bug)` case: a fast message and a standard message of identical size no longer produce identical
  cost once a multiplier is known.

## Verification (done)

A full scan of 372 transcripts produces exactly one fast bucket,
`claude-code/claude-opus-4-8-fast`, matching the single `"speed":"fast"` entry on disk. That model
publishes a 2x multiplier, so it is priced rather than flagged. No `claude-opus-5-fast` usage
exists here yet; if it appears it will be counted and reported as `partial` until a multiplier is
published.

## Risks

- **Retroactive split is impossible.** Usage already folded into the standard bucket stays there;
  only messages ingested after this lands are split. Say so in `status` output once, not on every
  run.
- **A wrong multiplier is worse than none.** If a source for `claude-opus-5` appears, add it with
  the citation in the comment. Never infer it from another model in the family: the published
  values range from 2.0 to 6.0 within one family, so the family tells you nothing.
