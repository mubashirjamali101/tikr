# tikr - CONTRIBUTING

A CLI that tracks Claude Code token usage from Claude Code's own local transcript files.

## Getting Started

Requires Node.js 18 or newer and `pnpm`.

```bash
pnpm install
pnpm run build
node dist/cli.js scan --verbose
```

There are **no runtime dependencies** - the tool uses only the Node standard library. Everything in
`package.json` is a dev dependency. Keep it that way unless there is a strong reason not to, and ask
before adding a runtime dependency.

## How it works

1. Claude Code writes a JSONL transcript per session to `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
2. Every `assistant` entry carries `message.model`, `message.id`, and `message.usage`.
3. `tikr` reads only the bytes appended since its last pass (byte offset per file), folds
   the usage into daily and per-project buckets, and writes `~/.tikr/state.json`.
4. The background service repeats step 3 on an interval.

**Read `docs/LESSONS.md` before touching `src/core/fold.ts` or `src/core/ingest.ts`.** The dedupe and
merge rules there are not arbitrary: they are the difference between correct numbers and a 2.2x
overcount.

### The two non-obvious facts about the data source

Both are measured against real transcripts, and they are why the ingest code looks the way it does.

1. **One API message appears as several JSONL entries**, one per content block, each carrying an
   identical copy of `message.usage`. Summing entries naively inflates output tokens about 2.2x and
   cache reads about 1.8x. Dedupe by `message.id` (with `requestId`, so a genuine retry still counts).
2. **Duplicate entries are strictly consecutive** (measured maximum gap: 1), and non-identical
   duplicates are partial-then-final streaming updates where `output_tokens` grows. So the fold is
   "merge by maximum within a series, add only the increase", which needs O(1) state per file.

## Local development loop

```bash
pnpm run typecheck
pnpm run test
node dist/cli.js scan --verbose --dry-run
```

`--dry-run` ingests and prints what it would record without writing state, which is the safe way to
test against your real transcripts.

Point the tool at fixtures instead of your real data with the two environment variables:

```bash
TIKR_HOME=/tmp/cc-test CLAUDE_CONFIG_DIR=/tmp/fake-claude node dist/cli.js scan
```

## Layout

```
src/cli.ts          Entry point and command dispatch
src/commands/       One file per CLI command
src/core/           Paths, state, parsing, the fold, blocks, pricing, crypto plumbing
src/providers/      One file per tracked tool, plus the registry
src/daemon/         PID lockfile and detached spawn
src/autostart/      Per-platform startup registration
src/otlp/           Local receiver for Claude Code's telemetry
src/report/         Table rendering, sections, formatting
src/tui/            The interactive dashboard
test/               Vitest unit tests
```

## Code standards

- **Every file at or below 200 lines.** The limit is what forces the split, and the split is what
  keeps the code readable a month later. Start refactoring at 199, not at 400.
- **No barrel exports (`index.ts`).** They hide the dependency graph and turn a rename into a
  mystery. Explicit imports only.
- **TDD.** Tests go in with the change, not after. A regression test carries a `(bug)` label and must
  fail before the fix and pass after; without that you have no proof the fix addresses the bug.
- **Correctness over cleverness in anything that counts.** Token counts are the product, and a wrong
  number that looks plausible is worse than a crash.
- **Verify a format against real data before writing a parser for it.** A parser written from a
  guess produces numbers that look right and are not, which is the single failure this tool exists
  to prevent. Say what you measured.
- **Never write inside a user's projects.** State goes in `~/.tikr/`, scratch in `.tmp/`.
- **Never mutate the source files.** Transcripts are read-only input, opened for reading only.
- **No emoji anywhere in output.** Either a real glyph with meaning, or nothing. Box-drawing
  characters and arrows in the terminal UI are typography, not decoration, and are fine.
- **No em dashes.** A hyphen, a comma, a colon, or two sentences.
- **Update `docs/TODOs.md`** as work moves, and `docs/LESSONS.md` after a fix is verified working.

## Commits

**Only humans are credited in git.** No agent, assistant, or automated tool may add itself as an
author, co-author, or contributor. That means no `Co-Authored-By:` trailer naming a model or a tool,
no "generated with" line, no agent name or emoji in the message, and no bot in the author or
committer field. This applies to commits, amends, merges, tags, and pull request descriptions.

The reasoning is not decoration. Git authorship is a statement about who is accountable for a
change, and accountability does not transfer to a tool. Whoever runs the commit has reviewed the
change and is answerable for it, so their name is the only one that belongs there.

Write the message about the change, not about how it was produced:

- What changed, and why it needed to change.
- What was measured, for anything that touches counting or pricing.
- The failure mode a fix prevents, so the next person recognises it.

## A note on `reset`

`tikr reset` deletes recorded statistics and requires `--yes`. Once Claude Code has pruned
the underlying transcripts, a reset is permanent: the history cannot be rebuilt. Use a throwaway
`TIKR_HOME` when testing rather than resetting your own record.

## Useful Commands

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run format
```

## Verification scripts

Neither runs as part of the test suite: both read the developer's own real transcripts, so their
output is a measurement of this machine rather than a fixture.

| Script | What it answers |
|---|---|
| `node scripts/gap-histogram.mjs` | Are a message's repeated entries still strictly consecutive? The ingest fold depends on it. |
| `pnpm run rates` | Regenerate the pricing table from LiteLLM. |

## Distribution

npm is the only channel, and it covers macOS, Linux and Windows from one artifact because the
package is plain JavaScript with no runtime dependencies and no native module. `bin` points at
`dist/cli.js`, which carries a shebang; npm creates a symlink on Unix and a `.cmd` shim on Windows.

Standalone binaries are deliberately not built. A Node runtime per platform costs tens of megabytes
and a cross-compilation step, for users who already have Node because Claude Code needs it.

CI packs the tarball, installs it globally and runs the binary off `PATH` on all three operating
systems. That is what the cross-platform claim rests on: the checks prove the code runs, the install
job proves the thing a user actually receives works.

## Releasing

1. `pnpm run rates` if the pricing table is stale, and check the diff. The Anthropic figures must
   still reconcile against Claude Code's own telemetry cost (see `docs/LESSONS.md`); a change there
   is a red flag, not a routine update.
2. Bump `version` in `package.json` **and** `src/version.ts`. A test fails if they disagree.
3. Add the release to `CHANGELOG.md`.
4. `pnpm run check` (lint, typecheck, tests). `prepublishOnly` runs it again.
5. `npm publish`. Only `dist/` ships; `README.md` and `LICENSE` are included by npm automatically.
6. Verify the published artifact rather than the working tree:

   ```bash
   npm pack
   npm install -g ./tikr-<version>.tgz
   tikr --version && tikr stats --no-scan
   ```

Verify against real data before releasing anything that touches counting or pricing. Green tests
have passed while the tool silently counted nothing: the fast-mode bug in `docs/LESSONS.md` was
caught only by scanning real transcripts and noticing a bucket that should have existed did not.
