# Phase 04: hourly resolution, five-hour blocks, burn rate, projection

**Problem.** The finest bucket we keep is the day. Every "am I about to run out" question, the
whole block model the rest of the field is built on, and any time-of-day view are impossible
without a finer axis. This phase adds that axis and the derivations it unlocks.

**Verified elsewhere:** ccusage's `identify_session_blocks` starts a block at the floor of the hour
of its first entry, ends it five hours later, closes it when either the elapsed time or the gap
since the previous entry exceeds the window, and inserts an explicit gap block between. Burn rate is
tokens per minute over the block's own span, with a cache-excluded variant for the visual indicator,
plus cost per hour. Projection extrapolates the burn rate to the end of the window.

## 04a. The hourly axis

New state section, additive and append-only like every other:

```ts
/** hour (`YYYY-MM-DDTHH`, local) -> model -> totals */
hourly: Record<string, Record<string, Totals>>
```

- Local hour, so it agrees with the existing local-day buckets. A user reasons in their own clock.
- Snapshot prefix `h`, added in `snapshot.ts` in the same change. Without it the ledger cannot
  rebuild the section, which is the easiest mistake available in this codebase.
- `recordedTokens` keeps deriving from `daily` only. Hourly is a second view of the same tokens, so
  including it would double the regression guard's measure and make the guard meaningless.
- Also store `lastActivityAt: string | null`, the newest observed message timestamp. Hour buckets
  cannot answer "how long ago", and the active block needs it.

Growth: 24 keys per day per active model, roughly 9k keys a year for one model. Acceptable, and
compactable later precisely because it is a derived view: an entry dropped from `hourly` costs
resolution, never a token. Record that as a TODO rather than building compaction now.

**Precision limit, stated plainly.** Aggregating to the hour means a block boundary is known to the
hour, not to the second. For the active block, `lastActivityAt` restores second-level precision at
the only place a user can perceive it. Blocks older than the current one are reported with their
hour-aligned start, which is what ccusage prints anyway because it floors the start to the hour.

The alternative, storing one row per message, was rejected: 40k rows a month, an unbounded ledger,
and no question it answers that hourly plus `lastActivityAt` does not.

## 04b. Block derivation

New pure module `src/core/blocks.ts`, no I/O, input is `hourly` plus `lastActivityAt`, output is
`SessionBlock[]`:

```ts
interface SessionBlock {
  startHour: string        // YYYY-MM-DDTHH
  endsAt: string           // startHour + 5h, ISO
  isActive: boolean
  isGap: boolean
  byModel: Record<string, Totals>
  costUsd: number
}
```

Rules, chosen to match ccusage's semantics on the data we actually keep:

1. Walk hours in order. The first hour with usage opens a block.
2. A block closes when the current hour is five or more hours past its start, or when five
   consecutive hours carry no usage.
3. A run of empty hours of five or more between two blocks emits a gap block.
4. The block containing the current hour is active when `lastActivityAt` is within the window.

Burn rate and projection live in the same module and are computed only for the active block:

- `tokensPerMinute`: block total over minutes elapsed from block start to `lastActivityAt`.
- `tokensPerMinuteExcludingCache`: same over input plus output only. Cache reads dominate the total
  by an order of magnitude here (5.9B against 13M output in `docs/LESSONS.md`), so a rate that
  includes them is useless as a "how hard am I working" indicator. This is why ccusage carries two.
- `costPerHour`: block cost over elapsed hours, using phase 02's basis so the projection inherits
  the same honesty label.
- `projection`: block total plus `tokensPerMinute` times minutes remaining. Suppressed when elapsed
  is under ten minutes, where extrapolating from a single message produces a number that is
  confidently absurd.

## 04c. Surfacing

- `stats --by block` prints the block table: start, elapsed and remaining, models, tokens, cost.
- The TUI (`src/tui/*`) gains a block panel: current block cost, time remaining, burn rate, and the
  projection. This is the screen that answers the question the whole category exists for.
- `stats --by hour` for a single day, which is also the heatmap's data source in phase 07.

## Work

1. `src/core/types.ts`: `hourly`, `lastActivityAt`, hydrate defaults, `STATE_VERSION` to 3.
2. `src/core/snapshot.ts`: `h` prefix.
3. `src/core/parse.ts`: `UsageRecord` gains `hour` and the raw ISO timestamp.
4. `src/providers/types.ts` and each provider: `UsageObservation` gains `hour` and `at`. Codex and
   Copilot both carry timestamps, so all three providers fill it.
5. `src/core/ingest.ts`: `bucket(state.hourly, observation.hour, model)`, one line beside the
   existing daily and project folds; advance `lastActivityAt` monotonically.
6. `src/core/blocks.ts` (new, pure).
7. `src/commands/stats.ts`, `src/tui/*`.

## Tests

- Hourly fold: two messages in the same hour merge, one in the next hour does not.
- Block boundaries: a six-hour run splits into two blocks; a five-hour silence emits a gap; usage
  resuming after the gap opens a new block.
- Active detection: `lastActivityAt` inside the window is active, outside is not.
- Burn rate: known tokens over known minutes; the cache-excluded variant differs; both suppressed
  when the block is under ten minutes old.
- Rebuild: mutate, commit, `verify --rebuild`, assert the rebuilt `hourly` equals the original. This
  is the assertion that catches a forgotten snapshot prefix.
- `(bug)` case: a state file written by version 2 loads, gets empty `hourly`, and does not fail the
  regression guard.

## Verification (done)

A full scan of real data produces 344 hourly buckets and 107 blocks over 21 recorded days. The
ledger round trip is exact: deleting `state.json`, rebuilding from the ledger, and diffing the
snapshots gives **0 differing keys out of 2,388**, hourly buckets included. That is the assertion
that catches a forgotten snapshot prefix, and it passes.

## Risks

- **Existing users start with an empty hourly axis.** No back-fill is possible: the bytes are
  consumed. `status` says so once, blocks appear from first use, and the daily history stays intact.
- **Timezone changes shift bucket keys.** Already true of the daily buckets; the tool never
  re-derives, so old keys keep their old labels. Do not attempt to rewrite them.
- **Five hours is Claude Code's window, not a law.** Keep it a named constant with a comment saying
  where it comes from, and let `--block-hours` override it for anyone whose plan differs.
