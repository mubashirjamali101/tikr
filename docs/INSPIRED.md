# Inspired By

What other public token usage trackers do, what is worth taking, and what is not. Every repo below
was cloned and read, not judged from its README. Claims about Claude Code's on-disk format were
re-verified against this machine's 217 transcripts before being written down.

## Field survey

| Project | Stack | Scope | Storage model |
|---|---|---|---|
| [ccusage/ccusage](https://github.com/ccusage/ccusage) | Rust workspace, npm launcher | 16 agent CLIs | Stateless. Re-reads every log on each run |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | Python, Rich TUI | Claude Code | Stateless, in-memory session blocks |
| [phuryn/claude-usage](https://github.com/phuryn/claude-usage) | Python stdlib, web dashboard | Claude Code | SQLite, incremental by mtime |
| [658jjh/claude-usage-tracker](https://github.com/658jjh/claude-usage-tracker) | Node + Swift shell, Chart.js | Claude and Codex | JSON snapshot per collection |
| [miwidot/cctracker](https://github.com/miwidot/cctracker) | Electron, React | Claude Code | Local app store |
| [ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel) | Docker, OTel collector, Grafana | Claude Code | Prometheus and Loki |

ccusage is the reference implementation of the category. It is the only one that treats source
support as an evidence problem: `docs/guide/source-support-qa.md` states the minimum a tool must
write locally (per-turn token counts, model id, timestamp, session id) and refuses to estimate from
transcript text, which is the same rule as `docs/PROVIDERS.md` here, reached independently.

## Techniques worth taking

Ordered by value to this tool. Each says what was verified.

### 1. Fast mode is a separate price, and the transcript says so

`speed` sits **inside** `message.usage`, next to the token counts. Verified here: 41,882
`"standard"`, 17 `null`, 1 `"fast"`. (An earlier reading of this put it at `message.speed`; that was
wrong, and it cost a build. See `docs/LESSONS.md`.) ccusage suffixes the model with `-fast` and multiplies the whole
computed cost by a per-model factor (`fast-multiplier-overrides.json`: 6.0 for opus-4-6 and 4-7,
2.0 for opus-4-8, 2.0 to 2.5 for the GPT-5.x family). `claude-opus-5` is absent from their table, so
the multiplier for the current model is unknown and must not be guessed.

Our pricing ignores `speed` entirely. Even one fast message priced at 1x is wrong; a user who
leaves fast mode on is understated by a large factor. Parse the field, keep it in the series key so
fast and standard usage never merge, and price it only once the multiplier is confirmed.

### 2. Long context is billed at a different rate

`Pricing` carries `input_above_200k` / `output_above_200k` and a per-model
`long_context_threshold`. The tier is selected per request by input size and then applies to every
bucket of that request, including cache. It is not a marginal breakpoint. OpenAI switches at 272K
(GPT-5 short-context maximum), Anthropic at 200K.

We charge one flat rate per model. Any session past the threshold is understated. Adopting this
needs per-request input size, which we deliberately do not retain, so the honest version is to
record a per-day count of over-threshold requests at ingest and price those tokens up.

### 3. Dedupe on `messageId` plus `requestId`

Verified here: `requestId` (`req_011...`) is present on **every** assistant entry, 42,382 of 42,382.
(A file-level count first suggested 202 of 217; the 15 others simply hold no assistant entries.) ccusage hashes
`messageId + requestId` rather than the message id alone, which distinguishes a genuine retry of the
same logical message from the repeated content blocks we already fold. Our `lastMessage` fold is
correct for the repeat case and cheaper, but the composite key costs nothing to add and closes the
retry case.

### 4. Five-hour blocks, burn rate, projection

`identify_session_blocks` groups entries into blocks that start at the floor of the hour of the
first entry and end five hours later, closing a block when either the block duration or the gap
since the previous entry exceeds the window, and emitting an explicit gap block in between. From the
active block it derives burn rate (tokens per minute, plus a cache-excluded variant used for the
visual indicator, plus cost per hour) and a projection to the end of the window.

This is the single most useful thing the category has that we lack. It is what answers "am I about
to run out", and it is pure derivation over data we already store per message, given timestamps.

### 5. Reset time comes from the transcript, not from a guess

ccusage scans lines where `isApiErrorMessage` is true for the literal `Claude AI usage limit
reached`, then reads the epoch after the following `|`. Verified here only in part: 14 files carry
`isApiErrorMessage`, 8 with `true`, and all 8 are connection or auth errors, so the limit marker
itself is unconfirmed on this machine. The parse is cheap and self-gating, so it can be adopted with
the marker treated as optional.

### 6. P90 of past blocks beats a hardcoded plan limit

`p90_calculator.py` estimates the user's real ceiling: keep completed, non-gap blocks whose total is
within 95% of any known plan limit (19k / 88k / 220k / 880k), take the 90th percentile of those
totals, and fall back to all completed blocks when none look limit-bound. Cached for an hour.

This is the right shape for a tool that must not lie: it reports the limit the user has actually
been hitting rather than a plan number scraped from marketing. The hardcoded `PLAN_LIMITS` table in
the same repo is the part to leave behind. It carries `unverified: true` and a guidance string on
the Team plan, which is an honest admission that these numbers are folklore.

### 7. Cost modes, and the fact that ours is now the only mode

ccusage supports `display` (use Claude Code's own `costUSD`), `calculate` (always from tokens), and
`auto` (prefer the recorded cost, fall back to tokens). Verified here: **`costUSD` appears in 0 of
217 transcripts**. Claude Code no longer writes it, so `display` and `auto` degrade to `calculate`
on current data. Our estimate-only path is not a shortcut; it is the only path left. What remains
worth copying is the vocabulary: say which mode produced a number. Our telemetry feed already gives
us a real recorded cost, which is the modern equivalent of their `display` mode.

### 8. Offline-first pricing with a live upgrade

Rates are embedded at build time from LiteLLM's table, with a models.dev snapshot as a second
embedded fallback, and a network fetch only when not in offline mode. Failures back off for 60s and
degrade to the embedded copy. `CCUSAGE_OFFLINE` forces the offline path, and the statusline defaults
to offline because it runs on every prompt.

Our rates are a hand-maintained literal, which is why the Sonnet 5 promotional window is a known
TODO. An embedded generated snapshot with a checked-in generator is strictly better: same zero
runtime dependencies, no drift by hand. A network fetch stays out of scope; this tool does not talk
to the network.

### 9. Statusline as a first-class command

`ccusage statusline` is wired into `~/.claude/settings.json` as a `statusLine` command and prints
session cost, today's cost, block cost with time remaining, burn rate, and the active model on one
line. It is the highest-frequency surface in the whole category and costs one command.

### 10. Presentation details that carry their weight

- Responsive tables: a width threshold (120 columns) below which columns are dropped rather than
  wrapped (`BLOCKS_COMPACT_WIDTH_THRESHOLD`).
- Project name normalization: strip the encoded `-Users-<name>-` prefix and support
  `key=value` aliases, so reports show `tikr` and not a path.
- `--last N` over days, weeks, or months resolved through one `last_periods_since` helper, with
  configurable week start.
- Config file with a published JSON schema, global defaults plus per-command overrides.
- Peak-hours heatmap and a most-expensive-session callout (658jjh) turn a table into an answer.
- Multi-currency display (cctracker) and per-model efficiency views.

### 11. What the OTel path adds, and what it costs

claude-code-otel wires Claude Code's own exporter into a collector, Prometheus, Loki and Grafana,
and gets metrics no transcript carries: `claude_code_cost_usage_USD_total`,
`claude_code_lines_of_code_count_total`, `claude_code_commit_count_total`,
`claude_code_pull_request_count_total`, `claude_code_session_count_total`, and tool-level events.

We already receive the token and cost metrics directly over OTLP/JSON with no dependencies, which is
the same data without a four-container stack. The unclaimed part is the non-token series: lines of
code, commits, pull requests, tool decisions. Those answer "what did the spend produce", which is a
better question than "how much did I spend", and they arrive on a feed we already listen to.

## Deliberately not adopted

- **Re-reading every log on every run** (ccusage, the monitor, 658jjh). Correct only while the
  source files exist. Claude Code deletes transcripts after 30 days, so a stateless tool reports a
  total that shrinks. See the retention entry in `docs/LESSONS.md`. Our append-only ledger exists
  precisely because this is the category's default and it is wrong.
- **A SQLite cache keyed on mtime** (phuryn). Skipping a file when mtime is unchanged and reparsing
  the whole file when it is, is simpler than byte offsets but loses the offset guarantee we rebuild
  from, and mtime granularity is a real risk on network filesystems.
- **Hardcoded subscription plan limits.** Published limits are not published. Estimating from
  observed blocks (item 6) is defensible; a table of guessed numbers is not.
- **Electron or a bundled web dashboard.** Every one of them ships a runtime and a chart library.
  This tool has zero runtime dependencies and that is a feature, not an accident.
- **Leaderboards and public profiles** (Straude, viberank, CCWarriors, Token Battle, all listed in
  ccusage's community page). They upload local usage to a third party. This tool sends nothing.
- **Paid or license-gated builds** (658jjh's signed app, at $9).

## Status

Everything below the "worth taking" heading is now implemented; `docs/plans/` has the design and the
verification for each. Two corrections came out of building it, both recorded in `docs/LESSONS.md`:
`speed` lives at `message.usage.speed` rather than beside it, and `requestId` is present on 100% of
assistant entries rather than the 202-of-217 files that a file-level count suggested.

## Adoption order

1. Parse `message.speed`, keep it out of the standard buckets, and flag fast usage as unpriced until
   the multiplier is confirmed. Wrong cost is the worst failure this tool can have.
2. Five-hour blocks with burn rate and projection, surfaced in `live`.
3. Composite `messageId + requestId` dedupe key.
4. Statusline command.
5. P90 ceiling estimate from completed blocks.
6. Generated pricing snapshot replacing the hand-maintained table.
7. Long-context tier counting at ingest.
8. Project name normalization and aliases; `--last N` over weeks and months.
9. Claude Code's non-token OTel series (lines of code, commits, pull requests).
