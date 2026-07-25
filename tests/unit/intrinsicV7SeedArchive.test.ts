import { describe, expect, it } from 'vitest'
import {
  INTRINSIC_V7_SPLIT_QUANTILES,
  INTRINSIC_V7_MAXIMUM_DIAGNOSTIC_SAMPLES_PER_ARM,
  intrinsicV7BalancedAtomicAllocations,
  retainV7LegalEndpointArchive,
  type IntrinsicV7Endpoint
} from '../../src/workers/algorithm/irregular/intrinsicV7SeedArchive.js'

function endpoint(input: {
  readonly seedRole: IntrinsicV7Endpoint['seedRole']
  readonly stateKey: string
  readonly terminalIdentity?: string
  readonly area?: string
  readonly hullNumerator?: number
  readonly hullDenominator?: number
}): IntrinsicV7Endpoint {
  return {
    seedRole: input.seedRole,
    stateKey: input.stateKey,
    terminalIdentity: input.terminalIdentity ?? 'same-quarter-turn-terminal',
    placedCollisionGeometries: [],
    metric: {
      envelopeAreaGrid2: input.area ?? '100',
      envelopeMaximumSideGrid: 10,
      enclosedCavityCount: 0,
      hullGapRatio: (input.hullNumerator ?? 1) / (input.hullDenominator ?? 10),
      hullGapDoubledAreaGrid2: String(input.hullNumerator ?? 1),
      hullDoubledAreaGrid2: String(input.hullDenominator ?? 10),
      isolatedPieceCount: 0,
      positiveContactComponentCount: 1,
      largestPositiveContactComponentRatio: 1,
      dominantContacts: 1,
      totalContacts: 1,
      envelopeSpanGrid: 20
    }
  }
}

describe('intrinsic V7 seed archive', () => {
  it('keeps q-orientation-distinct future states by phase-aware state key', () => {
    const retained = retainV7LegalEndpointArchive([
      endpoint({ seedRole: 'canonical-grid', stateKey: 'phase:q0' }),
      endpoint({ seedRole: 'canonical-grid', stateKey: 'phase:q90' })
    ])

    expect(retained.map(({ stateKey }) => stateKey)).toEqual(['phase:q0', 'phase:q90'])
  })

  it('compares hull-gap Pareto values with their exact grid-area fractions', () => {
    const retained = retainV7LegalEndpointArchive([
      endpoint({
        seedRole: 'canonical-grid',
        stateKey: 'ten-percent',
        hullNumerator: 1,
        hullDenominator: 10
      }),
      endpoint({
        seedRole: 'legacy-absolute-envelope',
        stateKey: 'eleven-percent',
        hullNumerator: 11,
        hullDenominator: 100
      })
    ])

    expect(retained.map(({ stateKey }) => stateKey)).toContain('ten-percent')
  })

  it('retains one-grid-square area improvements above Number.MAX_SAFE_INTEGER', () => {
    const retained = retainV7LegalEndpointArchive(
      [
        endpoint({
          seedRole: 'canonical-grid',
          stateKey: 'larger',
          area: '1000000000000000000'
        }),
        endpoint({
          seedRole: 'canonical-grid',
          stateKey: 'smaller',
          area: '999999999999999999'
        })
      ],
      1
    )

    expect(retained.map(({ stateKey }) => stateKey)).toEqual(['smaller'])
  })

  it('accepts half-grid hull areas through a doubled integer representation', () => {
    expect(() =>
      retainV7LegalEndpointArchive([
        endpoint({
          seedRole: 'canonical-grid',
          stateKey: 'half-grid-gap',
          hullNumerator: 66_189_013_267,
          hullDenominator: 200_000_000_001
        }),
        endpoint({
          seedRole: 'legacy-absolute-envelope',
          stateKey: 'integer-grid-gap',
          hullNumerator: 66_189_013_268,
          hullDenominator: 200_000_000_002
        })
      ])
    ).not.toThrow()
  })

  it('enumerates every balanced integer allocation for an odd atomic move', () => {
    expect(intrinsicV7BalancedAtomicAllocations(5)).toEqual([2, 3])
    expect(intrinsicV7BalancedAtomicAllocations(-5)).toEqual([-3, -2])
    expect(intrinsicV7BalancedAtomicAllocations(4)).toEqual([2])
  })

  it('registers the three independent split quantiles exactly once', () => {
    expect(INTRINSIC_V7_SPLIT_QUANTILES).toEqual([1 / 3, 1 / 2, 2 / 3])
    expect(INTRINSIC_V7_MAXIMUM_DIAGNOSTIC_SAMPLES_PER_ARM).toBe(24)
  })
})
