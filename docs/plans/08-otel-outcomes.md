# Phase 08: what the spend produced

**Problem.** Every tracker in the field, including this one, answers "how much did I spend". Claude
Code's own telemetry also carries what came out the other end, and nobody local consumes it. Cost
per commit is a better number than cost.

**Verified elsewhere:** `claude-code-otel` builds a Grafana stack around
`claude_code_lines_of_code_count_total` (split by `type`, added against removed),
`claude_code_commit_count_total`, `claude_code_pull_request_count_total`,
`claude_code_session_count_total`, and per-tool decision events. **Verified here:** we already
receive `claude_code.token.usage` and `claude_code.cost.usage` over OTLP/JSON with no dependencies
(`docs/LESSONS.md`), so the transport, the receiver and the DELTA/CUMULATIVE handling all exist.
**Unverified here:** the exact names and attributes of the non-token series, because only the two
token metrics were exercised when the receiver was built.

This is the phase with the best ratio of value to work in the whole plan: the pipe is already open.

## Step 1: observe before parsing

Before any code, run a real export with `CLAUDE_CODE_ENABLE_TELEMETRY=1` into the existing receiver
with a capture mode that writes every metric name, attribute key and value type it sees to
`.tmp/otlp-capture.txt`. Then write the parser from that capture, and paste the metric list into
this file as the evidence. This is the same rule that produced `docs/PROVIDERS.md`, applied to a
source we already have half of.

Two traps already recorded and still applicable: OTLP/JSON encodes int64 as a **string**
(`"asInt": "281"`), and a CUMULATIVE series must be differenced per series rather than added.

## Step 2: store

Extend `OtelState` with a counters map rather than a field per metric, so a new upstream metric
needs no schema change:

```ts
/** metric -> day -> attribute signature -> value */
counters: Record<string, Record<string, Record<string, number>>>
```

- Snapshot prefix `x`, keyed `x|<metric>|<day>|<signature>`.
- The attribute signature is the sorted `key=value` join of the attributes we keep (`type` for
  lines of code, `tool_name` and `decision` for tool events). Unknown attributes are dropped, not
  stored: an unbounded attribute set would grow the key space without bound.
- These are counts, not tokens, so they stay out of `recordedTokens` and out of every token total.
  The existing rule that telemetry and transcripts are never summed applies unchanged.

## Step 3: report

A short section in `stats`, present only when the data exists:

```
Produced (from Claude Code telemetry, last 30 days)
  Lines added        14,208     $0.42 per 100
  Lines removed       3,901
  Commits                61     $9.71 each
  Pull requests           7
  Sessions              212
```

Per-unit figures use the telemetry cost figure, which is Claude Code's own number, not our estimate,
so the basis is `reported` (phase 02) and the two never mix in one row.

Also worth having, and cheap once the counters exist: tool decision counts (accepted against
rejected per tool). It says which tools are earning their tokens. Show it only under `--verbose`;
the default report stays short.

## Work

1. `src/otlp/parse.ts` (110 lines): extend to non-token metrics, splitting the metric routing into
   `src/otlp/metrics.ts` if it approaches the limit.
2. `src/core/types.ts`, `src/core/snapshot.ts`: `counters` and the `x` prefix.
3. `src/commands/stats.ts` and the TUI: the produced section.
4. `src/commands/telemetry.ts`: mention that the outcome metrics arrive on the same feed, in one
   line, without turning the setup text into a manual.

## Tests

- `asInt` as a string parses; as a number parses; as junk contributes zero rather than `NaN`.
- CUMULATIVE differencing per series, including a series that resets (an export restart) which must
  contribute the new value once and never a negative.
- A metric with an unknown attribute key stores under the same signature as one without it.
- Counters never touch `recordedTokens`, asserted directly.
- `(bug)` case: two exports of the same cumulative counter add the increment once, not twice.

## Risks

- **The metric names are unverified here.** Step 1 exists precisely so none of this is written from
  memory. If a metric turns out not to be exported by the installed Claude Code version, it is
  omitted from the report rather than shown as zero. A zero that means "not measured" is a lie.
- **Attribution is by receipt time**, like the existing telemetry buckets, so a count can land in
  the next day's bucket near midnight. Already a known TODO for tokens; the same note covers this.
- **Telemetry is opt-in and off by default**, so this section is absent for most users. It must
  never look like missing data: show the section only when the feed is active.
