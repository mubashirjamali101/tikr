#!/usr/bin/env node
// Regenerates src/core/rates.generated.ts from LiteLLM's public price table.
//
// Run by a developer (`pnpm run rates`), never at install or run time: the tool itself never opens
// a socket. The output is committed, and like any generated file it is never hand-edited. To
// correct a wrong upstream value, add an entry to OVERRIDES in src/core/rates.ts, which wins.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'rates.generated.ts')

/** Models the readers can actually report: Anthropic and OpenAI chat models, bare ids only. */
function wanted(id, model) {
  if (id.includes('/') || id.includes(':')) return false
  if (!/^(claude-|gpt-[0-9]|o[0-9]|codex)/.test(id)) return false
  if (/-\d{8}$/.test(id) || /-\d{4}-\d{2}-\d{2}$/.test(id)) return false
  if (model.mode !== undefined && model.mode !== 'chat' && model.mode !== 'responses') return false
  return model.litellm_provider === 'anthropic' || model.litellm_provider === 'openai'
}

/** Dollars per million tokens, rounded so float noise does not land in a committed file. */
function perMillion(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Number((value * 1_000_000).toFixed(6))
}

function longContext(model, input) {
  for (const threshold of [200_000, 272_000, 128_000]) {
    const suffix = `_above_${threshold / 1000}k_tokens`
    const longInput = perMillion(model[`input_cost_per_token${suffix}`])
    if (longInput === null) continue
    return {
      threshold,
      input: longInput,
      output: perMillion(model[`output_cost_per_token${suffix}`]) ?? longInput * 5,
      cacheWrite5m:
        perMillion(model[`cache_creation_input_token_cost${suffix}`]) ?? longInput * 1.25,
      cacheWrite1h:
        perMillion(model[`cache_creation_input_token_cost_above_1hr${suffix}`]) ?? longInput * 2,
      cacheRead: perMillion(model[`cache_read_input_token_cost${suffix}`]) ?? longInput * 0.1,
    }
  }
  return null
}

const response = await fetch(SOURCE)
if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
const table = await response.json()

const rates = {}
for (const [id, model] of Object.entries(table)) {
  if (!wanted(id, model)) continue
  const input = perMillion(model.input_cost_per_token)
  const output = perMillion(model.output_cost_per_token)
  if (input === null || output === null) continue
  const rate = {
    input,
    output,
    // Cache write prices are published outright, so they are used verbatim. The 1.25x / 2x
    // multipliers are only a fallback for a model that omits them.
    cacheWrite5m:
      perMillion(model.cache_creation_input_token_cost) ?? Number((input * 1.25).toFixed(6)),
    cacheWrite1h:
      perMillion(model.cache_creation_input_token_cost_above_1hr) ?? Number((input * 2).toFixed(6)),
    cacheRead: perMillion(model.cache_read_input_token_cost) ?? Number((input * 0.1).toFixed(6)),
  }
  const long = longContext(model, input)
  if (long !== null) rate.long = long
  rates[id] = rate
}

const ids = Object.keys(rates).sort()
const ordered = {}
for (const id of ids) ordered[id] = rates[id]

const header = `// GENERATED FILE - DO NOT EDIT.
//
// Source:    ${SOURCE}
// Generated: ${new Date().toISOString().slice(0, 10)} by scripts/generate-rates.mjs
// Models:    ${ids.length}
//
// Rates are US dollars per million tokens. Regenerate with \`pnpm run rates\`. To correct a value,
// add an entry to OVERRIDES in rates.ts rather than editing this file: hand-edits are lost on the
// next regeneration, which is the same trap as hand-edited migrations.
//
// The table is a JSON string rather than an object literal so this file stays inside the 200-line
// limit as the model list grows. It is parsed once, lazily, on first pricing lookup.

export const GENERATED_AT = '${new Date().toISOString().slice(0, 10)}'

export const GENERATED_RATES_JSON =
  ${JSON.stringify(JSON.stringify(ordered))}
`

writeFileSync(OUT, header, 'utf8')
console.log(`wrote ${ids.length} models to ${OUT}`)
