# Phase 03: composite series key

**Problem.** The series key is `message.id` alone. That is correct for the repeated-content-block
case measured in `docs/LESSONS.md`, but it cannot distinguish a genuine retry of the same logical
message from another copy of it. If Claude Code ever reuses a message id across an API retry, the
retry's tokens are folded in as "no increase" and vanish.

**Verified here** (2026-08-11): `requestId` is present in 202 of 217 transcripts, formatted
`req_011Cdw...`. **Verified elsewhere:** ccusage hashes `messageId + requestId` for its dedupe set.

## Design

Series id becomes `${messageId}:${requestId ?? ''}`. Retention stays `last-only`, which is what
makes the fold O(1) per file, but that is only sound if duplicate entries for a composite key are
still strictly consecutive. That was measured for the bare message id, not for the composite, so it
is re-measured before the switch, not after.

The measurement is `scripts/gap-histogram.mjs`, which walks every transcript, records the entry
index of each composite key, and prints a histogram of the gap between consecutive occurrences. The
existing finding is "always exactly 1". If the composite key produces any gap greater than 1, the
switch is wrong as designed and the phase stops for review rather than quietly moving to
`retention: 'all'`, which would grow state without bound.

## Upgrade boundary

Existing `FileState.series` entries hold bare message ids. On the first pass after upgrade, the
in-flight message of every live transcript has a bare id and the incoming observation has a
composite one, so `previous.id === observation.series` fails and `counted` resets to zero. That
double-counts the in-flight message once per live file: small, but it is exactly the class of
silent inflation this tool exists to prevent.

Fix without a migration pass: when the stored id has no `:` and the incoming id's prefix before `:`
equals it, treat it as a match and carry `counted` forward. Ten lines in `apply()`, correct for
every file, and self-retiring once no bare ids remain. Add a comment saying it can be deleted after
one retention window has passed, with the date.

## Work

1. `src/core/parse.ts`: `UsageRecord` gains `requestId: string | null`; read `record.requestId`.
2. `src/providers/claude.ts`: build the composite series id.
3. `src/core/ingest.ts`: the prefix-match carry-forward in `apply()`, with the retirement note.
4. Codex and Copilot are untouched. Their series are the session and the model, and neither has a
   request id.

## Tests

- Two entries, same message id, different request ids: both are counted, totals add.
- Two entries, same message id and request id, second with a larger `output_tokens`: only the
  increase is counted (the existing streaming case, still passing).
- Entry with no `requestId`: composite degrades to `messageId:`, behavior unchanged from today.
- `(bug)` upgrade case: state holding a bare-id series, followed by a composite-id observation with
  identical totals, adds nothing. Fails before the carry-forward, passes after.

## Verification (done)

Gap histogram over 218 transcripts, 42,382 assistant entries: every repeat of a composite key is at
a gap of exactly 1, the same as for the bare message id.

```
bare:      repeats 18980  gaps [[1,18980]]
composite: repeats 18980  gaps [[1,18980]]
```

So `retention: 'last-only'` stays sound and the switch is safe. `requestId` turned out to be present
on **100%** of assistant entries (42,382 of 42,382), not the 202-of-217 files the earlier file-level
count suggested. The script is `scripts/gap-histogram.mjs`; re-run it after any large Claude Code
version jump.

## Risk

Low value if retries never happen, and the honest framing is that no retry has been observed here.
It is cheap and closes a failure mode that would be invisible if it did happen, which is the whole
argument. If the gap histogram comes back dirty, the correct outcome is to keep the current key and
record why in `docs/LESSONS.md`.
