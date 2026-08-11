# Phase 06: statusline

**Problem.** The highest-frequency surface in this category is one line in Claude Code's own prompt,
and we do not have it. A user who has to run a command to see their spend checks it once a day; a
user who sees it while typing changes behavior.

Depends on 02 (a priced number with a basis) and 04 (a block).

**Verified elsewhere:** `ccusage statusline` is registered in `~/.claude/settings.json` under
`statusLine` as `{ type: "command", command: "...", padding: 0 }`, receives a JSON object on stdin,
and prints one line. It defaults to offline pricing because it runs on every prompt.

## Design

```
tikr statusline
```

Reads the hook payload from stdin (session id, model, workspace directory), prints exactly one line,
exits 0. Prints nothing and exits 0 on any failure: a broken statusline must never wedge the prompt
or paint an error into it.

Output, in this order, dropping fields right to left as the terminal narrows:

```
opus-5  session $1.24  today $18.40  block $6.10 (2h11m left)  3.4k tok/min
```

- Session cost, today's cost, active block cost with time remaining, burn rate, model.
- No emoji and no icons (`docs/CONTRIBUTING.md`). The separator is two spaces, not a glyph.
- Currency and token formatting reuse `src/report/format.ts`, so it matches every other surface.

## Session cost without a session bucket

State aggregates by day, model, project and hour, not by session, and adding a per-session bucket
would grow without bound for a number nobody asks about historically.

Instead the statusline resolves the current transcript from the hook payload
(`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, honoring `CLAUDE_CONFIG_DIR`), reads it
standalone, and folds it with the existing parser. Bounded by one file, needs no new state, and
costs nothing when the payload is absent (the field is simply omitted).

**Crucially, it writes nothing.** The statusline is a reader. Ingesting from it would race the
daemon for the ledger and the state file, and a lock contention in the prompt path is a bug that
would surface as a hang while typing.

## Performance

This runs on every prompt render, so the budget is strict:

- **Measured: 151ms per invocation** over 20 runs on real data, against a 50ms target. 84ms of that
  is scrypt deriving the record key (2^15, deliberately slow, and a fresh process cannot reuse the
  per-process cache); 9ms is the actual work. The plan's fallback was a daemon-written summary file,
  and it is **rejected**: it would write usage figures to disk in plaintext to save time the user
  cannot perceive, since Claude Code runs this between turns rather than between keystrokes.
- Load state, do not scan. No `fs.watch`, no daemon start, no directory walk.
- Pricing is the embedded table from phase 02, which is already offline by construction.
- If the state file is missing or sealed for another machine, print nothing.

## Setup command

`tikr statusline --install` prints the exact JSON block to add to
`~/.claude/settings.json` and the path of that file. It does **not** edit the file: that is the
user's configuration, the same reasoning that keeps this tool away from `cleanupPeriodDays`
(`docs/LESSONS.md`). `tikr telemetry` already sets this precedent of printing setup rather
than performing it, and the two commands should read alike.

## Work

1. `src/commands/statusline.ts` (new): stdin read with a short timeout, compose, print.
2. `src/report/statusline.ts` (new): pure formatting, given a resolved model, so it is testable
   without any I/O and without a terminal.
3. `src/core/session.ts` (new): resolve and fold one transcript file standalone.
4. `src/cli.ts`: register the command and add it to `HELP`.

## Tests

- Formatting: full width, and each narrower width dropping the expected field.
- Missing state, missing stdin payload, malformed JSON on stdin, and a session file that does not
  exist: each prints nothing and exits 0.
- The session fold over a fixture transcript matches the daily fold over the same file.
- `(bug)` case: running the statusline does not modify `state.json` or append to the ledger. Assert
  both file hashes are unchanged after the command.

## Risks

- **Prompt latency is user-visible in a way a CLI is not.** If the 50ms budget cannot be met with a
  full state load, cache a small derived summary written by the daemon and read only that. Do not
  hide the cost by making the statusline asynchronous; a stale number with no indication is worse.
- **The hook payload shape is Claude Code's, and it can change.** Every field is read defensively
  and independently, so a renamed key costs one field, not the line.
