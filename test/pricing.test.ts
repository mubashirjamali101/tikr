import { describe, expect, it } from 'vitest'
import {
  costBasis,
  estimateCost,
  modelsMissingFastRate,
  modelsPricedByFamily,
  parseModelKey,
  weakestBasis,
} from '../src/core/pricing.js'
import { canonicalModel, longContextThreshold, lookupRate } from '../src/core/rates.js'
import { type Totals, emptyTotals } from '../src/core/types.js'

function usage(over: Partial<Totals> = {}): Totals {
  return { ...emptyTotals(), ...over }
}

describe('rate lookup', () => {
  it('prices a known model from the published table', () => {
    // 1M input at $5/MTok.
    expect(estimateCost('claude-code/claude-opus-5', usage({ input: 1_000_000 }))).toBeCloseTo(5, 6)
  })

  it('prices cache writes by TTL and cache reads at the published discount', () => {
    const cost = estimateCost(
      'claude-code/claude-opus-5',
      usage({ cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 }),
    )
    expect(cost).toBeCloseTo(6.25 + 10 + 0.5, 6)
  })

  it('falls back to the family and says so', () => {
    expect(costBasis('claude-code/claude-opus-9-experimental')).toBe('family')
    expect(
      estimateCost('claude-code/claude-opus-9-experimental', usage({ input: 1_000_000 })),
    ).toBe(5)
  })

  it('folds the dotted spelling other tools use onto the same rate', () => {
    expect(canonicalModel('claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
    expect(lookupRate('claude-sonnet-4.5').exact).toBe(true)
  })

  it('applies a date-bounded rate only inside its window', () => {
    const million = usage({ input: 1_000_000 })
    // Sonnet 5 is introductory-priced at $2 through 2026-08-31, then $3.
    expect(estimateCost('claude-code/claude-sonnet-5', million, '2026-08-11')).toBeCloseTo(2, 6)
    expect(estimateCost('claude-code/claude-sonnet-5', million, '2026-09-01')).toBeCloseTo(3, 6)
  })
})

describe('fast mode', () => {
  it('splits the bucket key without losing the model', () => {
    expect(parseModelKey('claude-code/claude-opus-5-fast')).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-5',
      fast: true,
      long: false,
    })
  })

  it('multiplies the whole bucket, cache included, when the surcharge is published', () => {
    const totals = usage({ input: 1_000_000, cacheRead: 1_000_000 })
    const standard = estimateCost('claude-code/claude-opus-4-8', totals)
    const fast = estimateCost('claude-code/claude-opus-4-8-fast', totals)
    expect(fast).toBeCloseTo(standard * 2, 6)
  })

  it('charges the standard rate and flags it when the surcharge is unknown', () => {
    const totals = usage({ input: 1_000_000 })
    expect(estimateCost('claude-code/claude-opus-5-fast', totals)).toBeCloseTo(
      estimateCost('claude-code/claude-opus-5', totals),
      6,
    )
    expect(costBasis('claude-code/claude-opus-5-fast')).toBe('partial')
    expect(modelsMissingFastRate(['claude-code/claude-opus-5-fast'])).toEqual([
      'claude-code/claude-opus-5-fast',
    ])
  })

  it('(bug) does not merge fast and standard usage into one price', () => {
    // Before fast mode was parsed, both spellings priced identically, understating fast usage.
    const totals = usage({ output: 1_000_000 })
    expect(estimateCost('claude-code/claude-opus-4-6-fast', totals)).not.toBeCloseTo(
      estimateCost('claude-code/claude-opus-4-6', totals),
      6,
    )
  })
})

describe('long context', () => {
  it('reports a threshold only for models that publish a tier', () => {
    expect(longContextThreshold('claude-sonnet-4-5')).toBe(200_000)
    expect(longContextThreshold('claude-opus-5')).toBeNull()
  })

  it('prices every bucket of a long request at the tier rate', () => {
    const totals = usage({ input: 1_000_000, output: 1_000_000 })
    // Sonnet 4.5: $3/$15 standard, $6/$22.50 above 200K.
    expect(estimateCost('claude-code/claude-sonnet-4-5', totals)).toBeCloseTo(18, 6)
    expect(estimateCost('claude-code/claude-sonnet-4-5-long', totals)).toBeCloseTo(28.5, 6)
  })
})

describe('basis reporting', () => {
  it('names the weakest basis present', () => {
    expect(weakestBasis(['claude-code/claude-opus-5'])).toBe('exact')
    expect(weakestBasis(['claude-code/claude-opus-5', 'claude-code/claude-opus-5-fast'])).toBe(
      'partial',
    )
    expect(weakestBasis(['claude-code/claude-opus-5-fast', 'claude-code/made-up-model'])).toBe(
      'family',
    )
  })

  it('lists family-priced models for the report footer', () => {
    expect(modelsPricedByFamily(['claude-code/claude-opus-5', 'codex/made-up'])).toEqual([
      'codex/made-up',
    ])
  })
})
