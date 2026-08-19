# Changelog

## 1.2.0 - 2026-08-20

### Install

- `install.sh` / `install.ps1` run `tikr start` after placing the binary, so a supported tool that
  is already on the machine is configured and tracked without a second command. `TIKR_SKIP_START=1`
  installs the binary only.
- `tikr start` detects installed providers, writes Grok's `[telemetry]` keys when Grok is present
  (and does not steal an off-loopback OTEL collector), and turns the OTLP receiver on when a tool
  needs it. `--no-setup` and `--no-otlp` opt out. A service that was already running without the
  receiver is restarted so Grok numbers start landing.

## 1.1.0 - 2026-08-20

### Tracking

- Grok CLI / Grok Build. Session files under `~/.grok` were checked against a real install and do
  not carry per-turn input/output tokens. tikr therefore reads Grok from the opt-in OTEL log event
  `grok_code.api_request` (protobuf or JSON) and folds it into the main ledger as `grok/<model>`.
  Enable with `tikr start --otlp` and the env vars printed by `tikr telemetry`. No backfill of old
  Grok sessions. Token metrics are ignored so enabling both Grok exporters cannot double-count.
  Reasoning tokens are counted as output.

## 1.0.0 - 2026-08-11

First public release.

### Install

- One npm package for macOS, Linux and Windows. No runtime dependencies, no native modules, no
  build step on install. CI packs the tarball, installs it globally and runs the binary on all
  three operating systems.

### Tracking

- Reads Claude Code, Codex and GitHub Copilot CLI from their own local session files. Each format
  was verified against a real installation before a reader was written; tools that do not record
  usage locally are listed as untrackable with the evidence, never guessed at.
- Append-only by design. Claude Code deletes transcripts after 30 days, so totals are folded into
  an encrypted, hash-chained ledger and a deleted transcript never subtracts from them. A write
  that would lower the recorded total is refused.
- Encrypted at rest with a machine-bound key, so the history cannot be copied to another machine or
  edited in place. `verify` checks the chain; `verify --rebuild` restores the cache from it.
- Real-time: a filesystem watch means a new message is counted about half a second after it lands.
  An optional OTLP receiver accepts Claude Code's own telemetry, including its own cost figure.

### Cost

- Rates generated from LiteLLM's public table and committed, so pricing is exact and offline at
  once. Regenerate with `pnpm run rates`.
- Cache writes are priced by TTL, cache reads at their published rate, and models with a published
  long-context tier are billed at that tier for requests that exceed it.
- Fast mode is counted in its own bucket and priced with a published multiplier where one exists.
- Every figure carries a basis: `exact`, `family`, or `partial`. The report names the weakest one.

### Reporting

- Every table carries two totals: `Total`, which includes cache, and `In+out`, which is input plus
  output only. Cache reads outnumber output by two orders of magnitude in normal use, so the grand
  total mostly measures context size rather than work done. The dashboard overview draws its table
  twice instead, once each way, because the two orderings disagree.
- Five-hour blocks with burn rate and projection, which is the unit Claude Code actually meters.
- An observed ceiling estimated from your own blocks that hit a limit, never from guessed plan
  numbers, and labelled differently when no limit has ever been recorded.
- Group by model, tool, day, week, month, project, block, or hour of week. `--last`, `--since`,
  `--until`, JSON and CSV.
- `statusline` for Claude Code's own prompt, and an interactive terminal dashboard.
- Optional `~/.tikr/config.json` for defaults.
