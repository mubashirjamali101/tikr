# Phase 07: reporting, configuration, and export

**Problem.** `stats` groups by model, provider, day or project, over the last N days. Everything
else the field offers, and everything the hourly axis now makes possible, is missing.

Depends on phase 04 for anything time-shaped.

## 07a. Periods

**Verified elsewhere:** ccusage resolves `--last N` for days, weeks and months through one helper
(`last_periods_since`) with a configurable week start, rather than three ad-hoc date paths.

- `stats --by week` and `--by month`, folded from the existing daily buckets. No new state.
- `--last N` replaces the day-only `--days N`, which stays as an alias so nothing breaks.
- `--since` and `--until` as explicit `YYYY-MM-DD` bounds.
- One `src/core/periods.ts` with the whole calendar derivation and no I/O, tested against the
  boundary cases that always break: month wrap, year wrap, week start on Sunday against Monday, and
  a count of zero meaning the current period.

## 07b. Project names

**Verified elsewhere:** ccusage strips the encoded `-Users-<name>-` prefix from Claude Code's
project directory names and supports `key=value` aliases.

Our reports currently print the raw encoded directory, which is unreadable and, worse, contains the
user's account name. Normalizing is both a legibility and a hygiene improvement:
`-Users-me-code-my-app` becomes `my-app`.

- Pure function in `src/report/project.ts`, handling the macOS and Linux `-Users-`/`-home-` forms
  and the Windows backslash form.
- Aliases come from the config file (07c). Display only; the state key stays the encoded path, so
  nothing about attribution changes and no migration is needed.

## 07c. Configuration file

**Verified elsewhere:** ccusage supports global `defaults` plus per-command overrides in JSON, with
a published schema for editor completion.

`~/.tikr/config.json`, loaded once, lowest precedence:

```json
{
  "defaults": { "days": 30, "weekStart": "monday" },
  "commands": { "stats": { "by": "block" } },
  "projects": { "-Users-me-code-my-app": "counter" }
}
```

Precedence: CLI flag, then command block, then defaults, then built-in default. Unknown keys are
reported once and ignored, never fatal. The schema ships as
`docs/config-schema.json` in-repo rather than at a URL, because this tool has no site and will not
acquire one for a schema. Config never contains secrets and is not encrypted; it is not usage data.

## 07d. Views the hourly axis unlocks

- **Heatmap** of hour against weekday, from `state.hourly`, rendered with block characters in the
  TUI. Answers when the spend actually happens, which no table does.
- **Most expensive day, project and block**, one line each. A callout beats a sorted table for the
  single question "what cost me the most".
- **Yesterday and last week comparison** on the summary: a delta with direction, no editorializing.
- **Responsive tables.** Below 120 columns, drop columns rather than wrapping them
  (ccusage's `BLOCKS_COMPACT_WIDTH_THRESHOLD`). Our renderer wraps today, which turns a narrow
  terminal into unreadable output. Column priority is fixed and declared per table, not improvised.

## 07e. Export

`stats --json` exists. Add `--csv` for the same rows, because a spreadsheet is where a team expense
claim actually gets made. Both write to stdout, never to a file, so redirection stays the user's
choice and the tool never creates files outside `~/.tikr`.

## Work

1. `src/core/periods.ts`, `src/report/project.ts`, `src/core/config.ts` (all new, all pure except
   the one config read).
2. `src/commands/stats.ts` grows several groupings: split the rendering into
   `src/report/groups.ts` before it approaches 200 lines, not after.
3. `src/tui/*`: heatmap widget and callouts; `src/tui/widgets.ts` is at 143 lines, so the heatmap
   goes in its own file.
4. `docs/config-schema.json`, and a `README.md` section for the config file.

## Tests

- Periods: month wrap, year wrap, both week starts, zero count, invalid date rejected.
- Project names: macOS, Linux, Windows, an alias hit, an unknown project, and the empty string.
- Config: precedence order proven by a case where all four levels disagree; unknown key ignored;
  malformed JSON reported and ignored rather than fatal.
- Responsive tables: at 80, 100 and 200 columns, assert which columns are present.
- CSV: quoting of a project name containing a comma, and a header row that matches the JSON keys.

## Risks

- **Scope.** This phase is a bag of features, and it is the one most likely to bloat. The ordering
  inside it is deliberate: periods, then names, then config, then views, then export. Ship in that
  order and stop wherever the value stops.
- **Config invites configurability for its own sake.** Only options that already exist as flags may
  be configurable. A setting that has no flag is a feature nobody asked for.
