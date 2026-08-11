# Phase 05: the observed ceiling, and the reset time

**Problem.** A block total means nothing without something to compare it against. The field's usual
answer is a table of subscription limits, which are not published and are therefore folklore. The
better answer is already in the data: the user's own history says where they stop.

Depends on phase 04.

## 05a. Observed ceiling instead of a plan table

**Verified elsewhere:** `p90_calculator.py` keeps completed, non-gap blocks whose total is within
95% of any known plan limit, takes the 90th percentile of those totals, falls back to all completed
blocks when none look limit-bound, and caches for an hour.

The statistic is sound; its inputs are not. Its "known plan limits" list is guessed, and the same
repo's plan table carries `unverified: true` on the Team row, which is an honest admission. So we
keep the estimator and drop the folklore:

- Candidate blocks are completed, non-gap blocks with usage.
- A block is **limit-bound** when a usage limit event was observed inside its window (05b), not when
  its total resembles a guessed number. This is a real signal rather than a circular one.
- The ceiling is the 90th percentile of limit-bound block totals when there are at least three of
  them, and otherwise the maximum completed block total, labelled differently.
- The report always states which of the two it is and how many blocks it came from. A ceiling from
  two samples is presented as an observation, never as a limit.

Never invent a plan name. The tool does not know which plan the user is on and must not imply it.

## 05b. Limit events from the transcript

**Verified elsewhere:** ccusage scans lines with `isApiErrorMessage: true` for the literal
`Claude AI usage limit reached`, then reads the epoch following the next `|`.

**Verified here, partially:** 14 of 217 transcripts contain `isApiErrorMessage`, 8 with `true`, and
all 8 are connection or auth errors. The limit marker itself does not appear on this machine, so the
exact text is unconfirmed against real data. That is the whole reason for the design below.

- The parser is defensive: absence is the normal case, no warning, no error.
- Matching is done on the marker substring, then the first run of digits after the following `|`.
  Both an epoch in seconds and in milliseconds are accepted, disambiguated by magnitude.
- A synthetic fixture drives the test, and the fixture file says in a comment that it was written
  from ccusage's parser and not from an observed local line. When a real one is seen, replace the
  fixture with it and record the difference.

New state section, additive:

```ts
limits: { events: Array<{ at: string; resetAt: string | null }> }
```

Snapshot prefix `l`, keyed `l|<at>` with value 1, so the ledger replays events like any counter and
the append-only invariant holds. Bounded in practice: a limit event is rare, and the section is
capped at the most recent 200 with the count of dropped events retained.

## 05c. Surfacing

- `stats` and the TUI show, for the active block: percent of the observed ceiling, with the sample
  count in the same line.
- When a reset time is known and still in the future, show it as a local time. Never show a
  countdown that keeps ticking after its basis expired.
- Threshold wording is fixed and unexcited: at 80% of the ceiling the figure is highlighted, at 100%
  it says the ceiling has been passed. No exclamation marks, no encouragement, no emoji.
- A notification hook is deliberately not built. The state-file approach in the Python monitor
  (`notification_states.json` with per-alert triggered flags) is the right shape if it is ever
  wanted; it is recorded here so the design does not have to be re-derived.

## Work

1. `src/core/parse.ts`: detect the marker, return a `LimitEvent` alongside the usage record. Keep
   parse.ts under 200 lines; if it does not fit, split the limit parse into `src/core/limits.ts`.
2. `src/core/types.ts`, `src/core/snapshot.ts`: the `limits` section and its `l` prefix.
3. `src/core/ingest.ts`: record the event; it carries no tokens, so it must not touch any total.
4. `src/core/ceiling.ts` (new, pure): the P90 estimator over blocks from phase 04.
5. `src/commands/stats.ts`, `src/tui/*`.

## Tests

- Marker with a seconds epoch, a milliseconds epoch, a missing pipe, and a non-numeric tail.
- A limit line contributes zero tokens to every bucket.
- Ceiling from three limit-bound blocks is their P90; from one it is the maximum, labelled as such;
  from none it is absent, not zero.
- `(bug)` case: an `isApiErrorMessage` line that is a connection error, matching the 8 real ones
  here, produces no limit event.

## Risks

- **The marker text may differ or may have changed.** It is unverified locally. Treat a run of
  months with zero events as expected, not as proof the parser works. Re-check whenever a real limit
  is hit, and record the observed line in `docs/LESSONS.md`.
- **A ceiling is a description, not a promise.** The wording must not imply the tool knows the
  account's limit. It knows where this user has previously stopped.
