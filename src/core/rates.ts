import { GENERATED_RATES_JSON } from './rates.generated.js'

/** Dollars per million tokens, one figure per token category. */
export interface Rate {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  /** Tier that replaces every rate above `threshold` context tokens, when the model publishes one. */
  long?: {
    threshold: number
    input: number
    output: number
    cacheWrite5m: number
    cacheWrite1h: number
    cacheRead: number
  }
}

/** A rate that applies only within a date window, `YYYY-MM-DD`, both bounds inclusive. */
interface DatedRate {
  from?: string
  until?: string
  rate: Rate
}

/**
 * Hand-verified corrections, which win over the generated table.
 *
 * Everything here needs a comment naming its source. The generated file is regenerated wholesale,
 * so a fix applied there would be lost; this is where a fix survives.
 */
const OVERRIDES: Record<string, Rate> = {
  // Not present in LiteLLM's table. Priced as the Fable tier, which is what the published Anthropic
  // rate card lists for this class.
  'claude-mythos-5': {
    input: 10,
    output: 50,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
  },
}

/**
 * Rates that change on a known date.
 *
 * Sonnet 5 ships at an introductory $2/$10 per MTok through 2026-08-31 and reverts to the standard
 * Sonnet tier after that. The generated table carries the current figure, so only the future
 * window needs stating. A cost is priced with the entry whose window contains the bucket's day.
 */
const DATED: Record<string, DatedRate[]> = {
  'claude-sonnet-5': [
    {
      from: '2026-09-01',
      rate: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
    },
  ],
}

/**
 * Cost multiplier for fast mode, by model.
 *
 * Fast mode is billed above the standard rate, and the surcharge is model-specific: published
 * values range from 2.0 to 6.0 within a single family, so a family cannot be used to infer one.
 * A model absent from this table is priced at its standard rate and reported as `partial`, which
 * understates visibly rather than overstating invisibly.
 *
 * Source: ccusage's `fast-multiplier-overrides.json` (the only public collection of these).
 */
const FAST_MULTIPLIERS: Record<string, number> = {
  'claude-opus-4-6': 6,
  'claude-opus-4-7': 6,
  'claude-opus-4-8': 2,
  'gpt-5.6-sol': 2,
  'gpt-5.6-terra': 2,
  'gpt-5.6-luna': 2,
  'gpt-5.5': 2.5,
  'gpt-5.4': 2,
  'gpt-5.3-codex': 2,
}

let parsed: Record<string, Rate> | null = null

function generated(): Record<string, Rate> {
  if (parsed === null) parsed = JSON.parse(GENERATED_RATES_JSON) as Record<string, Rate>
  return parsed
}

/**
 * Canonical model id.
 *
 * Tools disagree on separators for the same model (`claude-sonnet-4.5` from Copilot,
 * `claude-sonnet-4-5` from Claude Code), and regional or vendor prefixes appear on some ids.
 * Normalising here means one rate serves every spelling.
 */
export function canonicalModel(model: string): string {
  let name = model.toLowerCase()
  const slash = name.lastIndexOf('/')
  if (slash !== -1) name = name.slice(slash + 1)
  name = name.replace(/^(us|eu|au|jp|global)\./, '').replace(/^anthropic\./, '')
  // Version separators only: a dot between digits. `gpt-5.5` keeps its dot because the generated
  // table uses it, so only Anthropic-style `4.5` spellings are folded to `4-5`.
  return name.replace(/^(claude-[a-z]+)-(\d+)\.(\d+)/, '$1-$2-$3')
}

function dated(name: string, day: string | null): Rate | null {
  const windows = DATED[name]
  if (windows === undefined) return null
  const when = day ?? new Date().toISOString().slice(0, 10)
  for (const entry of windows) {
    if (entry.from !== undefined && when < entry.from) continue
    if (entry.until !== undefined && when > entry.until) continue
    return entry.rate
  }
  return null
}

/** Family fallback for an unrecognised model id. Better than zero, and always flagged. */
function family(name: string): Rate | null {
  const scale = (input: number, output: number): Rate => ({
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  })
  if (name.includes('fable') || name.includes('mythos')) return scale(10, 50)
  if (name.includes('opus')) return scale(5, 25)
  if (name.includes('sonnet')) return scale(3, 15)
  if (name.includes('haiku')) return scale(1, 5)
  if (name.includes('mini') || name.includes('nano')) return scale(0.25, 2)
  if (name.startsWith('gpt-') || name.includes('codex') || name.startsWith('o'))
    return scale(1.25, 10)
  return null
}

export interface RateLookup {
  rate: Rate | null
  /** True when the rate came from a published figure for this exact model. */
  exact: boolean
  /** True when fast mode's surcharge for this model is known. */
  fastKnown: boolean
  fastMultiplier: number
}

/** Resolve a bare model id (no provider prefix, no `-fast` or `-long` suffix). */
export function lookupRate(model: string, day: string | null = null): RateLookup {
  const name = canonicalModel(model)
  const multiplier = FAST_MULTIPLIERS[name]
  const fast = { fastKnown: multiplier !== undefined, fastMultiplier: multiplier ?? 1 }
  const exact = dated(name, day) ?? OVERRIDES[name] ?? generated()[name]
  if (exact !== undefined && exact !== null) return { rate: exact, exact: true, ...fast }
  return { rate: family(name), exact: false, ...fast }
}

/** Context size above which this model switches tier, or null when it publishes no tier. */
export function longContextThreshold(model: string): number | null {
  return lookupRate(model).rate?.long?.threshold ?? null
}
