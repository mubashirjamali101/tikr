# Lessons Learned

This is you talking to your future self. Be detailed. Be specific. Name the file, the symptom, and
the reason the obvious fix was wrong.

**When to add an entry:** only after a human-reported issue has been solved AND verified working.
See the recording gate below. Do not pre-write a lesson on a hunch.

**Entry format:**

```markdown
### <Short title of the trap>

**Issue** - the symptom exactly as reported, plus the real root cause once found.
**Discussion** - options weighed, disagreements, and why the chosen path won over the alternatives.
**Solution** - what was actually changed.
**How to apply** - the generalized rule, so this never happens again.
**Date / files** - when, and which files.
```

---

## Carried-forward lessons (from prior projects, apply here by default)

These are not yet this project's lessons - they are defaults inherited from previous work that held
up over time. Delete any that turn out not to apply once the stack is settled.

- Keep every file under 200 lines. The limit is what forces the split, and the split is what keeps
  the code readable a month later. Refactoring starts at 199, not at 400.
- Never use barrel exports (`index.ts`). They hide the dependency graph, break tree-shaking, and
  turn a rename into a mystery.
- Validate at the boundary with a schema (Zod or equivalent), and derive the TypeScript type from
  the schema. A hand-written `type` next to a runtime shape drifts silently and the compiler never
  notices. Only a runtime parse fails loudly.
- Trust the code over the ticket. The ticket describes symptoms; the root cause is almost always
  somewhere else. Every RCA that skipped reading the actual call chain was wrong.
- Regression tests need a `(bug)` labelled case that fails before the fix and passes after. Without
  it, you have no proof the fix addresses the reported bug rather than something adjacent.
- A test that asserts a nested field can pass by coincidence when the outer envelope is missing.
  Assert the full shape the consumer actually receives.
- Never hand-edit generated files (migrations, snapshots, generated maps). Fix the source and
  regenerate. Hand-edits diverge and the divergence surfaces weeks later as duplicate DDL.
- Money is stored in the smallest unit (cents) and displayed in the major unit (dollars). Convert
  only at the boundary. Never expose the storage unit as a user-facing input.
- Never render internal IDs (UUIDs, DB ids) in user-facing text. Use a short public code or natural
  language.

---

## Verified findings about Claude Code transcripts

These are not human-reported bugs, so they did not go through the recording gate below. They are
measured facts about the data source, verified on 2026-08-11 against 212 real transcript files
(39,112 assistant entries, 2026-07-08 to 2026-08-11). They are recorded here because getting any of
them wrong silently produces wrong numbers, which is the worst possible failure for this tool.

### Summing assistant entries double-counts by ~2.2x

**Finding** - a single API message is written to the transcript as **several JSONL entries**, one per
content block, and every one of them carries an identical copy of `message.usage`. 11,971 of 19,768
distinct `message.id` values appeared in more than one entry.

**Measured impact of naive summing** - output tokens 29,227,817 vs 13,279,250 actual (2.2x inflation);
cache reads 10,379,621,114 vs 5,906,269,091 actual (1.76x).

**How to apply** - dedupe by `message.id`. Never sum over raw assistant entries. When a change to
`src/core/ingest.ts` makes the numbers go up, suspect this first.

### Duplicate entries are strictly consecutive, so dedupe state is O(1) per file

**Finding** - across all 212 files, the gap between consecutive entries sharing a `message.id` was
**always exactly 1**. Sidechain (subagent) entries never interleave into the middle of a message's
block run.

**Why it matters** - this is what makes the design cheap. An unbounded "seen message ids" set is not
needed; remembering only the **last** message per file is sufficient and correct.

**How to apply** - keep `lastMessage` per file in state. If a future Claude Code version interleaves
entries, this assumption breaks silently and undercounts. Re-run the gap-histogram check before
trusting a large version jump.

### Non-identical duplicates are partial-then-final, so merge by max

**Finding** - 332 message-id groups had differing usage across their entries. In every inspected
case, `input`/`cache_creation`/`cache_read` were stable and `output_tokens` **grew** (e.g. 3 -> 178,
2 -> 8091): the earlier entry is a partial streaming snapshot, the later one is final.

**How to apply** - within a `message.id`, take the **max** per field, not the first, last, or sum.
The implementation adds only the delta above what it already counted, so it is idempotent and can
flush a message immediately without waiting to see whether more entries follow.

### `<synthetic>` is not a real model

**Finding** - 16 entries carry `message.model: "<synthetic>"`. These are locally-generated messages,
not API calls.

**How to apply** - exclude them from token totals and cost. Counting them pollutes the per-model
breakdown with a model that was never billed.

### Claude Code deletes transcripts after 30 days, so any total recomputed from disk shrinks

**Reported symptom** - "yesterday my total output tokens were 100M, today they are around 70M; how
can tokens get reduced?"

**Root cause** - Claude Code deletes session files older than `cleanupPeriodDays` (**default 30**)
**at startup**. Confirmed on this machine:

- `~/.claude/.last-cleanup` = `2026-08-11T12:59:07Z` (cleanup ran that morning)
- Oldest surviving **session** transcript: `2026-07-13`, exactly 29 days old
- The 30-day cutoff for that date: `2026-07-12`
- Non-session files (`vercel-plugin/skill-injections.jsonl`) survive from **2026-03-27**, 137 days
  old, proving the cleanup targets session transcripts specifically rather than the whole tree

So the window slides by one day every day. Any tool that answers "how many tokens have I used?" by
reading every file currently on disk reports a number that **falls** as older sessions age out. The
tokens were real; the evidence was deleted.

**How to apply** - a usage tracker must be an **append-only ledger of its own**, never a recomputation
over the source files:

1. Read each transcript once, from a byte offset, and fold the result into stored aggregates.
2. Never re-derive totals from the file set. A file disappearing must not subtract anything.
3. Refuse any state write whose recorded total is **lower** than what is already stored
   (`StateRegressionError`). This is what turns the invariant from a convention into a guarantee -
   it catches the dangerous path where a corrupt state resets to empty and is then saved over the
   real record.
4. Keep a backup of the last good state and recover from it rather than starting over, and
   quarantine the damaged file instead of overwriting it. Once the transcripts are gone, a reset is
   permanent.
5. Count the tracked files that have vanished and say so, so the user learns their raw history is
   being pruned instead of silently trusting a shrinking number.

Verified end to end: with 213 real transcripts recorded, deleting 40 of them left the recorded
output tokens at exactly 13,738,800, unchanged, with `status` reporting the 40 deletions.

**Do not change `cleanupPeriodDays` on the user's behalf.** It is their configuration file, and the
tool is explicitly designed not to depend on it: once a transcript has been read, its retention is
irrelevant. Mention the setting only if asked.

### Encrypting local history protects against copying and editing, not against the owner

**Requirement** - "history should be non-transferable, non-editable, encrypted."

**What is actually achievable, and what is not.** The tool runs unattended as a background service,
so it must be able to decrypt without a human typing a passphrase. That means the key has to be
derivable from material on the machine, which means **any process running as this user can derive
it too**. Encryption here defeats: copying the data to another machine, reading it out of a backup
or a synced folder, and editing it in place. It does not defeat the owner of the account. Say this
plainly rather than implying the data is sealed against its owner.

**The design that follows from that:**

| Property | Mechanism |
|---|---|
| Encrypted | AES-256-GCM, key from scrypt(machine identity + per-install random salt) |
| Non-transferable | Machine identity is in the key: `IOPlatformUUID` (macOS), `/etc/machine-id` (Linux), `MachineGuid` (Windows). Copy the whole directory elsewhere and every record fails authentication. |
| Non-editable | GCM's tag makes any byte edit fail decryption, and a SHA-256 chain (`hash = sha256(seq, prev, ciphertext)`) makes removal, insertion, and reordering detectable. |
| Retained forever | Append-only JSONL. No code path rewrites or truncates it; nothing expires. |

**Two design points worth keeping:**

1. **The chain fields are plaintext on purpose.** `seq`, `prev`, and `hash` reveal nothing about
   contents, and keeping them readable means the chain can be verified, and a break located, without
   decrypting anything.
2. **Append to the ledger before writing the cache.** A crash between the two then leaves the ledger
   ahead of the cache, which is repairable by replaying. The reverse order leaves the cache holding
   numbers with no entry to justify them, which is not.

**Rebuild needs the file offsets too.** Replaying only the token deltas restores the totals but
loses each transcript's read offset, so the next scan re-ingests every surviving file and doubles
the recent numbers. Each ledger entry therefore carries the offsets alongside the deltas.

### An unconditional KeepAlive fights the lockfile and undoes `stop`

**Symptom** - the daemon log filled with `another service is already running (pid N); exiting` every
ten seconds, forever.

**Cause** - two mistakes compounding. `tikr start` spawned a daemon *and* registered a
launchd agent whose `RunAtLoad` starts a second one; the loser exits against the pidfile. Then
`KeepAlive: true` told launchd to restart whatever exits, so it relaunched the loser on a ten-second
throttle indefinitely. The same setting also silently undid `tikr stop` within seconds.

**Fix** - two parts, both needed:

1. `KeepAlive: {SuccessfulExit: false}` on macOS and `Restart=on-failure` on systemd. Restart after
   a crash, never after a clean exit. A deliberate stop is a clean exit.
2. When `start` is going to register a startup entry, let that entry start the process. launchd and
   systemd both launch the service as part of registering it, so spawning as well guarantees two
   copies racing for the lockfile.

**How to apply** - whenever a supervisor and an explicit command can both start the same process,
exactly one of them owns the lifecycle. Check for it by watching the log for a full minute after
`start` and counting processes: `pgrep -f 'dist/cli.js daemon' | wc -l` must be 1.

### Every tool reports running totals, so one fold rule covers all of them

**Finding** - three tools, three record shapes, one underlying pattern. Each reports a *cumulative*
figure for some series, and none reports a per-turn delta you can simply add up:

| Tool | A series is | Reported as | Verified |
|---|---|---|---|
| Claude Code | one `message.id` | repeated per content block, growing while streaming | 212 files |
| Codex | the session | `total_token_usage`, monotonic (99 records checked, never decreased) | 109 files |
| Copilot | one model in a session | `modelMetrics`, restated on every event | 45 files |

**How to apply** - take the maximum per field within a series and add only the increase. That is
idempotent, so re-reading a line changes nothing, and it self-corrects when a later snapshot is
larger. It replaced three would-be per-provider counting paths with one, and every provider bug
found since has been in *parsing*, never in counting.

Three traps that only show up on real data:

1. **Cached input is a subset, not an addition.** Codex's `cached_input_tokens` is the cached part
   *of* `input_tokens` (`input + output == total_tokens` holds exactly). Adding them double-counts;
   subtracting and booking the cached part as a cache read also prices it correctly.
2. **A series can outlive its labels.** A Codex session runs for hours and can switch models
   mid-way, so attributing the series to its *first* day and model piled multi-day sessions onto day
   one. Attribute each increment to the day and model observed at the time; the series only holds
   the baseline. Making the model part of the series id instead would be much worse - the running
   total would restart against a fresh baseline and double-count the whole session.
3. **One line can carry several series.** A Copilot event restates every model at once, so a parser
   returning a single observation per line silently drops all but the first.

### Transcripts are not all two levels deep - subagents nest deeper

**Finding** - the obvious layout is `projects/<encoded-project>/<session>.jsonl`, and a flat
two-level listing found 166 files. A recursive walk found **212**. The extra 46 are subagent
transcripts (`<project>/<session>/agent-<id>.jsonl`) and plugin records, and they carry real usage:
511 messages, 82,803 output tokens, and 36.8M cache-read tokens on the machine this was measured on.

**How it showed up** - totals looked plausible. Nothing errored. The tool simply reported less usage
than had actually happened, which is exactly the failure mode that never announces itself.

**How to apply** - walk recursively and attribute every transcript to its **top-level** project
directory. A depth cap guards against symlink loops. Whenever the totals need checking, compare
against an independent recount over `**/*.jsonl` rather than trusting the walk.

### Transcripts are written within ~2 seconds, so watching beats polling and beats a proxy

**Finding** - measured on a live session, a message's usage lands in the JSONL about **1.9 seconds**
after the message completes. The data source was never the bottleneck; the 15-second poll was.
Switching to `fs.watch` on the transcripts root took detection from "up to 15s" to a measured
**0.42s** (verified with the poll interval set to 300s, so only the watcher could have reacted).

**Why this matters more than it sounds** - it removes the main argument for intercepting Claude
Code's network traffic. A MITM proxy would require installing a root CA and routing every request
(including the OAuth token) through a local listener, would break on Claude Code updates, and would
buy roughly one second over simply watching a file.

**How to apply** - `fs.watch` with `recursive: true` works on macOS and Windows and throws
`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` on Linux. Keep the periodic scan as both the Linux path and a
safety net; never make the watcher the only trigger.

### Claude Code emits its own token and cost metrics over OpenTelemetry

**Finding** - setting `CLAUDE_CODE_ENABLE_TELEMETRY=1` makes Claude Code export
`claude_code.token.usage` and `claude_code.cost.usage`. Verified against Claude Code 2.1.126 by
running a real export into a local listener.

Two details that make this cheap to consume, both confirmed on the wire:

- **`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` works**, even though the docs foreground `grpc` and
  `http/protobuf`. The body is plain JSON, so no protobuf decoder and no runtime dependency.
- **`aggregationTemporality: 1`** (DELTA), so each export carries only the increment. Handle
  CUMULATIVE (2) as well by differencing against the last seen value per series - adding a
  cumulative total verbatim on each export multiplies usage.

**Traps** - OTLP/JSON encodes int64 as a **string** (`"asInt": "281"`), so a naive numeric read
yields `NaN` and silently zeroes every count. And telemetry counts the *same tokens* as the
transcripts, so the two must never be summed; keep them in separate buckets and report separately.

**What it uniquely provides** - Claude Code's own USD cost figure (not an estimate from list rates)
and a `query_source` attribute splitting `main` / `subagent` / `auxiliary`, neither of which the
transcripts expose.

### The telemetry cost figure validates the pricing model exactly

**Finding** - with both feeds running, Claude Code's own `claude_code.cost.usage` can be compared
against this tool's list-rate estimate over the *same* token counts. On 2026-08-11, for
`claude-opus-5` (929 input, 107,839 output, 1,077,232 cache-creation, 62,248,720 cache-read):

| | |
|---|---|
| Claude Code's reported cost | **$44.60** |
| This tool's estimate | **$40.56** |
| Gap | -9.1% |

The whole gap is one term. Telemetry reports `cacheCreation` as a single number with no TTL split,
so the receiver books it at the 5-minute rate (1.25x base input). This workload actually uses 1-hour
caching (2x). The difference is `1,077,232 x $5/MTok x (2.00 - 1.25)` = **$4.04**, and
`$40.56 + $4.04 = $44.60` - **residual $0.00**.

**What this proves** - the rate table ($5/$25 for Opus-tier) and all three cache multipliers
(1.25x / 2x / 0.1x) are correct. An independent source agrees to the cent once the one missing
input is supplied.

**What it does not mean** - the transcript path is unaffected. Transcripts *do* carry
`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, so the main `stats` estimate uses the
real split. The 5-minute fallback only applies to telemetry-derived buckets, and the telemetry
section reports Claude Code's own figure rather than an estimate, so nothing user-facing is wrong.
Keep the conservative fallback: guessing 1h everywhere would overstate workloads that genuinely use
short-lived caching.

### Fast mode is inside `usage`, and it is a different price

**Finding** - `speed` sits at `message.usage.speed`, alongside the token counts, **not** at
`message.speed`. Measured across every local transcript on 2026-08-11: 41,882 `standard`, 17 `null`,
1 `fast`. Fast requests are billed at a multiple of the standard rate, and the multiplier is
model-specific: the only public collection of them (ccusage's `fast-multiplier-overrides.json`)
lists 6.0 for `claude-opus-4-6` and `-4-7` but 2.0 for `-4-8`, so the family tells you nothing.

**How it showed up** - the first implementation read `message.speed`, which is always undefined. It
typechecked, every unit test passed against its own fixtures, and a full scan of 372 real
transcripts produced no `-fast` bucket at all despite one fast message existing on disk. Only the
end-to-end check caught it.

**How to apply** - a field's nesting is part of the format, so verify it by parsing a real line and
walking the object, not by grepping for the key: `grep` finds `"speed":"fast"` at any depth and
tells you nothing about where it lives. Keep fast usage in its own bucket (`<model>-fast`), price it
only with a published multiplier, and report it as `partial` otherwise. Never infer a multiplier
from a sibling model.

### `requestId` is on every assistant entry, and the composite key is still consecutive

**Finding** - `requestId` (`req_011...`) is present on **100%** of assistant entries: 42,382 of
42,382 across 218 transcripts. An earlier file-level count suggested 202 of 217 files, which was an
artifact of counting files rather than entries; the 15 files without it contain no assistant entries
at all.

**Why it matters** - the message id alone cannot distinguish a repeated content block, which must be
folded away, from a genuine retry of the same message, which must be counted. `messageId:requestId`
separates them.

**The gap histogram still holds for the composite key.** Every repeat of a composite key occurs at a
gap of exactly 1, the same result as for the bare id (18,980 repeats, all at gap 1). That is what
keeps `retention: 'last-only'` sound and the fold O(1) per file. Re-run `scripts/gap-histogram.mjs`
before trusting this through a large Claude Code version jump.

### Cache creation is split by TTL, and the two are priced differently

**Finding** - `usage.cache_creation` carries `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`
separately. A 5-minute cache write costs 1.25x base input; a 1-hour write costs 2x. Collapsing them
into the single `cache_creation_input_tokens` field loses the distinction and misprices by up to 60%.

**How to apply** - track the two buckets separately end to end. When `cache_creation` is absent on
an older entry, fall back to charging the whole amount at the 5-minute rate and accept the small
undercount rather than guessing high.

---

## Project lessons

<!-- Append verified lessons below, newest last. -->

_None yet._
