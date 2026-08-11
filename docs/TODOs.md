# TODOs

Every known issue, bug, and task. Update as new items are discovered and old ones resolved.

**Entry format:** `- [ ] **[P<n>]** <description> - _status_ (owner, date)`

Priority: `P0` blocker, `P1` high, `P2` normal, `P3` nice-to-have.
Status: `open`, `in progress`, `blocked`, `closed`.

---

## Open

`docs/plans/` sequences every technique surveyed in `docs/INSPIRED.md`. All eight phases are built
and verified; the items they closed are in the Closed section below.

- [ ] **[P3]** `state.hourly` grows by up to 24 keys per active day and is never compacted. It is a
      derived view, so dropping old entries costs resolution and never a token, unlike `state.files`.
      Compact hours older than a year once the file size justifies it - _open_ (2026-08-11)
- [ ] **[P3]** The usage-limit marker (`Claude AI usage limit reached|<epoch>`) is parsed from
      ccusage's implementation and has never been seen in local data, so the observed ceiling falls
      back to "largest completed block" here. Replace the synthetic fixture in `test/limits.test.ts`
      with a real line the first time a limit is hit - _open_ (2026-08-11)
- [ ] **[P3]** `claude_code.pull_request.count` has still never been observed locally, so its name
      is the only outcome metric taken on trust. The rest were confirmed against a live export on
      2026-08-11: `lines_of_code.count` (`type=added|removed`), `commit.count`, `session.count`,
      `code_edit_tool.decision` (`tool_name`, `decision`, `language`), `cost.usage` - _open_ (2026-08-11)
- [ ] **[P3]** `claude_code.active_time.total` arrives (seconds, `type=cli`) and is stored but not
      reported. Time spent is the one thing the tool cannot infer from transcripts, so it would make
      a real "cost per hour of work" figure - _open_ (2026-08-11)
- [ ] **[P1]** CI has never executed: there is no remote yet, so the macOS, Linux and Windows matrix
      is a workflow file rather than evidence. Push before publishing, and treat a green run as the
      gate for `npm publish` - _open_ (2026-08-11)
- [ ] **[P3]** No fast-mode multiplier is published for `claude-opus-5`, so any fast usage on it is
      reported as `partial` and priced at the standard rate. Add the value with a citation when one
      appears; never infer it from the family - _open_ (2026-08-11)
- [ ] **[P3]** `statusline` takes 151ms per invocation, 84ms of which is scrypt deriving the record
      key. Acceptable between turns, but revisit if Claude Code starts calling it more often
      - _open_ (2026-08-11)

- [ ] **[P2]** Decide whether this repo is under git; if so, add a `.gitignore` covering `dist/`,
      `node_modules/`, `.tmp/`, and local env files - _open_ (2026-08-11)
- [ ] **[P2]** `state.files` keeps an entry for every transcript ever seen, including ones Claude
      Code has deleted. This is deliberate (it stops a restored file being re-counted, and powers
      the pruned-file report) but is unbounded over years, roughly 2k entries/year. Compact old
      entries to path + offset once they have been missing for a long time - _open_ (2026-08-11)
- [ ] **[P2]** A rewritten transcript is resynced without ingesting, so its usage is lost. `status`
      surfaces the count. Consider recording per-file contributions so a rewrite can be corrected
      rather than skipped - _open_ (2026-08-11)
- [ ] **[P3]** No test covers the daemon loop or `spawnDaemon` directly; both were verified manually
      end to end. Add a test that runs the daemon against a fixture directory - _open_ (2026-08-11)
- [ ] **[P3]** Autostart `enable`/`disable` are verified by generated-file content plus a `plutil`
      lint, not by actually registering with launchd/systemd. Manual verification needed on Linux
      and Windows - _open_ (2026-08-11)
- [ ] **[P3]** `live` redraws the whole screen each frame; on a slow terminal this can flicker.
      Consider cursor-addressed partial redraws - _open_ (2026-08-11)
- [ ] **[P3]** The OTLP receiver accepts any loopback client without authentication. Fine for a
      single-user machine, but a shared host could have another local user post bogus counts.
      Consider a shared token if that ever matters - _open_ (2026-08-11)
- [ ] **[P3]** Telemetry daily buckets are keyed by receipt time, not by when the tokens were used.
      Exports arrive within the default 60s interval so this is near-exact, but a bucket can shift
      across midnight - _open_ (2026-08-11)
- [ ] **[P3]** No automated test drives a real `claude` process into the OTLP receiver; verified
      manually with a captured payload and a synthetic export - _open_ (2026-08-11)

- [ ] **[P2]** Recorded totals are append-only, but a per-day figure could still be understated if a
      transcript is deleted before its final bytes are ever read (a session ending right at the
      retention boundary). Quantify how often this can happen - _open_ (2026-08-11)

- [ ] **[P2]** The first ledger entry is a ~55KB backfill of every transcript offset. Later entries
      are 0.5-1.2KB. Consider a periodic compaction entry that supersedes older offset records so a
      multi-year ledger stays small - _open_ (2026-08-11)
- [ ] **[P3]** `verifyLedger` and `readPayloads` load the whole ledger into memory. Fine at present
      size; stream them once it reaches hundreds of MB - _open_ (2026-08-11)
- [ ] **[P3]** The keyring salt sits next to the data. Storing it in the macOS Keychain would raise
      the bar for an attacker with only filesystem access - _open_ (2026-08-11)

- [ ] **[P2]** Codex sessions are bucketed under a single "codex" project rather than the working
      directory in their `session_meta`, because discovery would have to read every file to group
      them. Read it lazily on first ingest instead - _open_ (2026-08-11)
- [ ] **[P3]** Copilot exposes `requests.cost`; it is parsed past but not recorded. Surface it the
      way Claude Code's telemetry cost is - _open_ (2026-08-11)
- [ ] **[P3]** `codex/codex-auto-review` is an internal label, not a billable model, so it is priced
      by family guess. Confirm what it maps to - _open_ (2026-08-11)


## In progress

_None._

## Closed

- [x] **[P2]** Open-source cleanup: authorship set on `package.json` and `LICENSE`, the account name
      removed from every example path, the agent-configuration files folded into
      `docs/CONTRIBUTING.md` and removed, CI across macOS, Linux and Windows on Node 18 and 22,
      `.editorconfig`, a `docs/` index, and the gap histogram promoted from scratch space to
      `scripts/gap-histogram.mjs` - _closed_ (2026-08-11)
- [x] **[P2]** Refactor: one `bucketFor`/`counterFor` shared by the fold, the ledger replay and the
      telemetry receiver instead of three copies; the dashboard reuses `sumByModel`/`bucketCost`
      rather than its own; one `percentOfCeiling` so the report and the dashboard cannot disagree
      - _closed_ (2026-08-11)
- [x] **[P1]** Release readiness: MIT `LICENSE`, `CHANGELOG.md`, npm-ready manifest (name, keywords,
      `files`, `prepublishOnly`), version 1.0.0 with a test pinning `src/version.ts` to
      `package.json`, `docs/config-schema.json`, and a release checklist in `docs/CONTRIBUTING.md`
      - _closed_ (2026-08-11)
- [x] **[P2]** (bug) `--version` printed the help text whenever stdout was not a terminal: the
      bare-invocation branch ran before the version check - _closed_ (2026-08-11)
- [x] **[P2]** (bug) A `false` value in `config.json` switched its option **on**: booleans are read
      by flag presence, and `false` was being stored as the string "false" - _closed_ (2026-08-11)
- [x] **[P2]** (bug) A limit event that fell off the 200-event cap diffed to -1 in the snapshot and
      was resurrected by the ledger replay - _closed_ (2026-08-11)
- [x] **[P3]** Day, week and month rows were priced at today's rate rather than the row's own date,
      so a row inside a promotional window was priced wrong - _closed_ (2026-08-11)
- [x] **[P3]** The hour-of-week heatmap covered all history while every other section honoured the
      report window - _closed_ (2026-08-11)
- [x] **[P3]** The cost footer claimed promotional pricing is never applied, which stopped being
      true once dated rates landed - _closed_ (2026-08-11)
- [x] **[P3]** `--until`, `--block-hours`, a `version` command, config for every command (not just
      `stats`), a reset time that names the day when it is not today, and `status` reporting hour
      coverage, limit events, and why blocks are empty on a migrated record - _closed_ (2026-08-11)
- [x] **[P1]** (bug) Fast-mode messages were priced at the standard rate: `speed` was read from
      `message.speed`, but Claude Code writes it at `message.usage.speed`. Caught by an end-to-end
      scan producing no `-fast` bucket despite one existing on disk. Fast usage now has its own
      bucket, a published-only multiplier table, and a `partial` cost basis when the surcharge is
      unknown - _closed_ (2026-08-11)
- [x] **[P1]** Generated pricing table from LiteLLM (69 models, committed, offline), with explicit
      cache-write and cache-read rates, long-context tiers, date-bounded rates (Sonnet 5's
      introductory window), and a cost basis on every figure - _closed_ (2026-08-11)
- [x] **[P2]** Hourly buckets, five-hour blocks, burn rate, projection, and an observed ceiling
      estimated from blocks that actually hit a limit rather than from guessed plan numbers.
      Ledger round trip verified exact: 0 differing keys out of 2,388 - _closed_ (2026-08-11)
- [x] **[P2]** `statusline` command for Claude Code's prompt, reading state and one transcript,
      writing nothing - _closed_ (2026-08-11)
- [x] **[P2]** Reporting: weeks and months, `--last` / `--since`, hour-of-week heatmap, callouts,
      responsive column dropping, CSV export, config file, and project names with the account name
      stripped - _closed_ (2026-08-11)
- [x] **[P3]** Composite `messageId:requestId` series key, gated on a re-run of the gap histogram
      (42,382 entries, every repeat at gap 1) - _closed_ (2026-08-11)
- [x] **[P3]** Telemetry outcome counters: lines of code, commits, pull requests, sessions and tool
      decisions, reported as cost per unit against Claude Code's own cost figure - _closed_ (2026-08-11)

- [x] **[P1]** Initialize agent docs scaffolding - _closed_ (2026-08-11)
- [x] **[P1]** Define the project and write the contributor documentation - _closed_ (2026-08-11)
- [x] **[P1]** Build the CLI: ingest, aggregation, pricing, reporting, background service,
      cross-platform autostart - _closed_ (2026-08-11)
- [x] **[P0]** (bug) Transcript discovery only walked two levels, silently dropping all subagent
      usage (46 files, 511 messages on the dev machine). Fixed with a recursive walk; regression
      test in `test/scan.test.ts` - _closed_ (2026-08-11)
- [x] **[P1]** Verify totals against an independent implementation. Exact match on input, output,
      cache write, cache read, and message count across 212 real transcripts - _closed_ (2026-08-11)
- [x] **[P2]** Fill in `docs/CONTRIBUTING.md` - _closed_ (2026-08-11)
- [x] **[P3]** Prune carried-forward lessons that do not apply to the chosen stack - _closed_ (2026-08-11)
- [x] **[P1]** Real-time tracking: `fs.watch` on transcripts (measured 0.42s detection with a 300s
      poll interval), an OTLP/JSON receiver for Claude Code's native telemetry, and a `live`
      terminal view - _closed_ (2026-08-11)
- [x] **[P0]** Diagnosed reported symptom "totals dropped from 100M to 70M overnight": Claude Code
      deletes sessions older than `cleanupPeriodDays` (default 30) at startup. Confirmed via
      `.last-cleanup` timestamp and a 29-day-old oldest surviving session. Hardened the tool into an
      append-only ledger: write-regression guard, backup/recovery with quarantine, pruned-file
      reporting, and `--no-backfill`. Verified on 213 real transcripts - deleting 40 left recorded
      output unchanged at 13,738,800 - _closed_ (2026-08-11)
- [x] **[P1]** Encrypted, append-only, machine-bound history: AES-256-GCM with a scrypt key over
      machine identity + per-install salt, SHA-256 hash chain, `verify` / `verify --rebuild`, and
      state.json demoted to a rebuildable cache - _closed_ (2026-08-11)
- [x] **[P0]** (bug) Tail read for the ledger head used a 4KB window, but the initial backfill entry
      is ~55KB. The fragment failed to parse, was read as "no entries", and restarted the sequence
      at 1, breaking the chain on the next append. Caught by `verify` on real data. Fixed with
      growing windows that require the line-start newline; regression tests in
      `test/ledger.test.ts` - _closed_ (2026-08-11)
- [x] **[P0]** (bug) `start` spawned a daemon while launchd also started one, and `KeepAlive: true`
      respawned the loser every 10s forever and silently undid `stop`. Fixed with
      `KeepAlive:{SuccessfulExit:false}` / `Restart=on-failure` and by letting the startup entry own
      the process. Verified: 1 process, 0 respawns over 45s - _closed_ (2026-08-11)
- [x] **[P1]** Multi-tool support: provider abstraction, plus Codex and GitHub Copilot CLI readers
      verified against real local data. Model keys namespaced `provider/model`, with legacy bare
      keys migrated on ledger replay so existing history survives. `providers` command documents
      what is trackable and what is not - _closed_ (2026-08-11)
- [x] **[P0]** (bug) `--days 0` is documented as "all history" but `flagInt` rejected 0 as invalid
      and silently fell back to 30 days, hiding 36 days of older usage. Fixed with an explicit
      minimum; regression test in `test/args.test.ts` - _closed_ (2026-08-11)
- [x] **[P1]** Interactive TUI: four views, keyboard navigation, live refresh on file change,
      responsive column shedding, and a grand total across every tool. Zero dependencies; driven
      end to end through a pty in testing - _closed_ (2026-08-11)
- [x] **[P0]** (bug) `paint` sliced the frame to `rows - 1`, which silently dropped the status bar
      it had just been fixed to keep. Now writes exactly `rows` lines with no trailing newline -
      _closed_ (2026-08-11)
- [x] **[P1]** (bug) Legacy bare model keys and their qualified equivalents rendered as two
      identical rows for one model. Normalised at read time rather than rewriting the append-only
      ledger - _closed_ (2026-08-11)
- [x] **[P3]** TUI sort control: `s` cycles tokens, cost, messages, name, shown in the status bar.
      The days view stays chronological under size sorts - _closed_ (2026-08-11)
- [x] **[P3]** (bug) Projects were attributed to `Object.keys(byModel)[0]`, an arbitrary pick that
      could differ between runs. Now attributed to the dominant tool by tokens, with every
      contributing tool listed in a Tools column - _closed_ (2026-08-11)
- [x] **[P2]** Evaluated network interception (MITM proxy) and rejected it: needs a root CA, exposes
      the OAuth token to the proxy, breaks on updates, and yields less than the telemetry feed.
      Rationale recorded in README and docs/LESSONS.md - _closed_ (2026-08-11)
