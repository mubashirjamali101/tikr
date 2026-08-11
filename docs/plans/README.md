# Implementation plan: best-of-breed usage tracking

Turns every technique in `docs/INSPIRED.md` into buildable phases, ordered so that correctness
lands before features.

**Status: all eight phases are built, tested and verified against real data** (2026-08-11). Each
phase doc keeps its plan, and the ones whose claims were checked against local transcripts carry a
"Verification (done)" section with the measured result. Two things changed during the build and are
recorded where they happened: `speed` turned out to live inside `usage` (phase 01), and the
statusline's latency target was missed and the fallback rejected (phase 06).

| Phase | Outcome | Blocks |
|---|---|---|
| [01](01-fast-mode.md) | Fast-mode usage is separated and never mispriced | none |
| [02](02-pricing.md) | Generated rate table, long-context tiers, cost provenance | 01 |
| [03](03-dedupe.md) | Composite `messageId + requestId` series key | none |
| [04](04-time-and-blocks.md) | Hourly resolution, five-hour blocks, burn rate, projection | none |
| [05](05-limits.md) | Observed ceiling (P90) and limit reset time | 04 |
| [06](06-statusline.md) | `statusline` command for Claude Code's prompt | 02, 04 |
| [07](07-reporting.md) | Weeks, months, aliases, config file, heatmap, export | 04 |
| [08](08-otel-outcomes.md) | Lines of code, commits, pull requests per dollar | none |

Phases 01, 03, 04 and 08 can run in parallel. 02 needs 01's model key. 05 and 07 need 04's hourly
buckets. 06 needs a priced number and a block.

## Invariants no phase may break

These are settled. A phase that appears to need one relaxed is wrong and stops for review.

1. **Recorded totals only ever grow.** Transcripts are deleted after 30 days; a number that falls
   is data loss. `saveState` refuses a shrinking write (`StateRegressionError`) and every new
   aggregate must be additive so the guard keeps meaning.
2. **The ledger is the record, `state.json` is a rebuildable cache.** Append to the ledger first,
   write the cache second (`commit.ts`). Every new bucket needs a `snapshot.ts` key prefix so a
   rebuild reproduces it.
3. **Read once, from a byte offset.** No phase re-derives totals by re-reading files.
4. **Zero runtime dependencies, no network.** Generated data is generated at development time and
   committed. Nothing new may open a socket except the existing local OTLP receiver.
5. **Never guess a number and present it as measured.** An unknown rate is flagged, not assumed.
   This is the rule that separates this tool from the field.
6. **Verify the format against real data before writing the parser.** Every claim in a phase is
   tagged `verified here`, `verified elsewhere`, or `unverified`. Unverified means write the code
   defensively and treat absence as normal.
7. **Files stay at or below 200 lines**, no barrel exports, TDD with a `(bug)` case for anything
   that was ever wrong in production.

## State migration policy

`STATE_VERSION` goes from 2 to 3 once phase 01 or 04 lands, whichever is first. One migration, not
four: batch the shape changes so users see a single version step.

- `hydrate()` in `src/core/state.ts` gains defaults for every new section, and `readCandidate`
  accepts versions 1, 2 and 3. Discarding an old state file is permanent loss, so it is never done.
- New sections start empty for existing installs. History is not back-filled: the bytes were
  already consumed and are not re-read. Phase docs say exactly what an existing user will and will
  not see, and `status` reports it in one line rather than leaving it a mystery.
- Every new aggregate gets a `snapshot.ts` prefix in the same change as the state field. A field
  without a prefix is invisible to the ledger and silently lost on rebuild. This is the single
  easiest mistake to make in this codebase.

Current prefixes: `d` daily, `p` projects, `o` telemetry daily, `c` telemetry cost, `s` telemetry
source. Reserved by this plan: `h` hourly, `l` limit events, `x` outcome counters.

## Definition of done, per phase

Beyond the code standards in `docs/CONTRIBUTING.md`:

1. `pnpm run lint`, `pnpm run typecheck`, `pnpm run test` all clean.
2. A test that would have failed before the change, for every behavior claimed.
3. Round-trip proof: mutate state, append to ledger, `verify --rebuild`, assert the rebuilt cache
   equals the original. Any new bucket is included in that assertion.
4. Measured against real local data, with the number written into the phase doc as evidence.
5. `docs/PROVIDERS.md` or `README.md` updated when user-visible behavior changes. No lesson is
   recorded unless the gate in `docs/CONTRIBUTING.md` is met.

## What is explicitly out of scope

Recorded so it is not relitigated: stateless re-reads, SQLite mtime caches, hardcoded subscription
plan limits, Electron or web dashboards, chart libraries, leaderboards or any upload, paid tiers,
and live currency conversion (it needs a network call for a number nobody reconciles against).
