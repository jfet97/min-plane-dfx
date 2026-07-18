import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  FreeMaterialSnapshot,
  IrregularBounds,
  IrregularLayoutScoreSummary,
  IrregularNestingSettings,
  IrregularPoint,
  IrregularPolygon,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  CANONICAL_REFERENCE_ADMISSION_SLACKS,
  canonicalPortfolioResultFrom,
  canonicalReferenceDecodeSheets,
  canonicalReferenceRoleLifecycleDiagnostics,
  evaluateCanonicalReferenceAdmissionMetrics,
  isCanonicalReferenceRoleEligible,
  portfolioProgressForDecodeRole
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import type { IrregularLayoutScore } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import type { CanonicalLayoutTopology } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { prefixedDecisionTraceDecodeId } from '../../src/workers/algorithm/irregular/portfolioSearch.js'
import {
  makeCompactQualityIrregularOptimizerSettings,
  makeDefaultIrregularNestingSettings
} from '@shared/irregular/defaults.js'

const fixturePath = fileURLToPath(
  new URL('../fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const mixedRequest = Schema.decodeUnknownSync(NestingRequest)(
  JSON.parse(readFileSync(fixturePath, 'utf8'))
)
const mixedSettings = mixedRequest.options.irregularSettings
if (mixedSettings === undefined) throw new Error('mixed-61 fixture must carry irregular settings')
const canonicalSettings = Schema.decodeUnknownSync(IrregularNestingSettings)({
  ...mixedSettings,
  optimizer: {
    ...mixedSettings.optimizer,
    canonicalReferenceDecodeEnabled: true
  }
})
const compactQualityNoRepairSettings = Schema.decodeUnknownSync(IrregularNestingSettings)({
  ...mixedSettings,
  optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
})
const nonReferenceRequest = new NestingRequest({
  ...mixedRequest,
  sheet: new SheetSpec({ width: 2000, height: 1700, label: 'non-reference' })
})

function preparedWorkloadPiece(input: {
  readonly index: number
  readonly family: string
  readonly sideMm: number
}): IrregularPreparedPiece {
  const sourcePieces = mixedRequest.sourcePieces ?? []
  const source = sourcePieces[input.index % Math.max(1, sourcePieces.length)]
  if (source === undefined) throw new Error('mixed fixture must carry source pieces')
  const points = [
    new IrregularPoint({ x: 0, y: 0 }),
    new IrregularPoint({ x: input.sideMm, y: 0 }),
    new IrregularPoint({ x: input.sideMm, y: input.sideMm }),
    new IrregularPoint({ x: 0, y: input.sideMm })
  ]
  const polygon = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(`workload-${input.index}`),
    interchangeabilityKey: input.family,
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({
        minX: 0,
        minY: 0,
        maxX: input.sideMm,
        maxY: input.sideMm
      }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: new IrregularPoint({ x: 0, y: 0 }),
      diagnostics: []
    }),
    transforms: []
  })
}

const mixedScalePrepared = Array.from({ length: 21 }, (_, index) =>
  preparedWorkloadPiece({
    index,
    family: index % 2 === 0 ? 'small-family' : 'large-family',
    sideMm: index % 2 === 0 ? 10 : 25
  })
)

const homogeneousPrepared = Array.from({ length: 21 }, (_, index) =>
  preparedWorkloadPiece({ index, family: 'one-family', sideMm: 10 })
)

const uniformMultiFamilyPrepared = Array.from({ length: 21 }, (_, index) =>
  preparedWorkloadPiece({
    index,
    family: index % 2 === 0 ? 'first-family' : 'second-family',
    sideMm: 10
  })
)

const topology: CanonicalLayoutTopology = {
  largestOccupiedHullGapRatio: 0.2,
  positiveContactComponentCount: 5,
  isolatedPieceCount: 2,
  largestPositiveContactComponentSize: 53
}

function score(overrides: Partial<IrregularLayoutScore> = {}): IrregularLayoutScore {
  return {
    unplacedCount: 0,
    sharedCollisionBoundaryLengthMm: 100,
    sharedCollisionBoundaryContactUnits: 20,
    sharedCollisionBoundaryContactBand: 20,
    nearCompleteStructuralContactCount: 57,
    dominantNearCompleteStructuralContactCount: 17,
    largestNetFreeMaterialRegionAreaMm2: 1,
    freeMaterialRegionCount: 1,
    freeMaterialHoleCount: 2,
    freeMaterialSliverMetric: 1,
    collisionBoundsWorstNormalizedSheetConsumption: 1,
    collisionBoundsNormalizedSpanSum: 1,
    collisionBoundsAreaMm2: 500_000,
    collisionBoundsSpanMm: 1_500,
    occupiedHullWasteRatio: 0.2,
    collisionBoundsBottomMm: 0,
    collisionBoundsLeftMm: 0,
    freeMaterialSnapshot: new FreeMaterialSnapshot({
      sheet: mixedRequest.sheet,
      regions: [],
      diagnostics: []
    }),
    placementOrder: [],
    unplacedSourcePieceIds: [],
    ...overrides
  }
}

const canonicalScore = () =>
  score({
    collisionBoundsAreaMm2: 430_000,
    collisionBoundsSpanMm: 1_420,
    nearCompleteStructuralContactCount: 53,
    dominantNearCompleteStructuralContactCount: 14
  })

describe('canonical reference coordinator policy', () => {
  it('does not claim a canonical attempt when production cancellation skips the role', () => {
    const diagnostics = canonicalReferenceRoleLifecycleDiagnostics({
      shouldAttemptCanonical: true,
      reusesProduction: false,
      productionStatus: 'cancelled',
      canonicalAttempted: false,
      canonicalStatus: 'cancelled'
    })

    expect(diagnostics.map(({ code }) => code)).toEqual(['canonical_reference_role_rejected'])
    expect(diagnostics[0]?.message).toContain('was not attempted')
    expect(diagnostics.some(({ code }) => code === 'canonical_reference_role_attempted')).toBe(false)
  })

  it('distinguishes both external progress roles and trace decode identities', () => {
    const progress = new IrregularPortfolioProgress({
      phase: 'deterministic_beam',
      elapsedMs: 0
    })
    expect(portfolioProgressForDecodeRole(progress, 'production').decodeRole).toBe('production')
    expect(portfolioProgressForDecodeRole(progress, 'canonical-reference').decodeRole).toBe(
      'canonical-reference'
    )
    const productionId = prefixedDecisionTraceDecodeId('production:', 'baseline-0')
    const canonicalId = prefixedDecisionTraceDecodeId('canonical-reference:', 'baseline-0')
    expect(productionId).not.toBe(canonicalId)
    expect(new Set([productionId, canonicalId]).size).toBe(2)
  })

  it('materializes the selected canonical score through its schema-owned class', () => {
    const selectedScore = canonicalScore()
    const result = canonicalPortfolioResultFrom({
      source: new IrregularPortfolioResult({
        status: 'completed',
        terminationReason: 'ga_disabled',
        source: 'beam',
        placements: [],
        unplacedPieceIds: [],
        diagnostics: []
      }),
      state: new IrregularBeamState({
        remainingPreparedPieces: [],
        placedCollisionGeometries: [],
        placementOrder: []
      }),
      score: selectedScore
    })

    expect(result.score).toBeInstanceOf(IrregularLayoutScoreSummary)
    expect(Schema.decodeUnknownSync(IrregularPortfolioResult)(result).score).toMatchObject({
      sharedCollisionBoundaryLengthMm: selectedScore.sharedCollisionBoundaryLengthMm,
      sharedCollisionBoundaryContactUnits: selectedScore.sharedCollisionBoundaryContactUnits,
      sharedCollisionBoundaryContactBand: selectedScore.sharedCollisionBoundaryContactBand,
      nearCompleteStructuralContactCount: selectedScore.nearCompleteStructuralContactCount,
      dominantNearCompleteStructuralContactCount:
        selectedScore.dominantNearCompleteStructuralContactCount
    })
  })

  it('plans two decodes only for eligible non-reference jobs', () => {
    expect(
      isCanonicalReferenceRoleEligible(nonReferenceRequest, canonicalSettings, mixedScalePrepared)
    ).toBe(true)
    expect(
      canonicalReferenceDecodeSheets(nonReferenceRequest, canonicalSettings, mixedScalePrepared)
    ).toHaveLength(2)

    const referenceRequest = new NestingRequest({
      ...mixedRequest,
      sheet:
        canonicalReferenceDecodeSheets(nonReferenceRequest, canonicalSettings, mixedScalePrepared)[1] ??
        mixedRequest.sheet
    })
    expect(
      canonicalReferenceDecodeSheets(referenceRequest, canonicalSettings, mixedScalePrepared)
    ).toHaveLength(1)

    const firstPiece = mixedRequest.pieces[0]
    if (firstPiece === undefined) throw new Error('mixed fixture must contain a piece')
    const homogeneousRequest = new NestingRequest({
      ...nonReferenceRequest,
      pieces: Array.from(
        { length: 21 },
        (_, index) =>
          new PreparedPiece({
            ...firstPiece,
            id: PieceId.make(`homogeneous-${index}`)
          })
      )
    })
    expect(
      canonicalReferenceDecodeSheets(homogeneousRequest, canonicalSettings, homogeneousPrepared)
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(homogeneousRequest, canonicalSettings, mixedScalePrepared)
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(
        nonReferenceRequest,
        canonicalSettings,
        uniformMultiFamilyPrepared
      )
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(
        new NestingRequest({ ...homogeneousRequest, pieces: homogeneousRequest.pieces.slice(0, 20) }),
        canonicalSettings,
        mixedScalePrepared.slice(0, 20)
      )
    ).toHaveLength(1)
  })

  it('requires an explicit compact-quality canonical decode capability', () => {
    const defaults = makeDefaultIrregularNestingSettings()
    expect(defaults.optimizer.beamWidth).toBe(1)
    expect(defaults.optimizer.canonicalReferenceDecodeEnabled).toBe(false)
    expect(
      canonicalReferenceDecodeSheets(nonReferenceRequest, defaults, mixedScalePrepared)
    ).toHaveLength(1)
    expect(compactQualityNoRepairSettings.optimizer.canonicalReferenceDecodeEnabled).toBe(true)
    expect(
      canonicalReferenceDecodeSheets(
        nonReferenceRequest,
        compactQualityNoRepairSettings,
        mixedScalePrepared
      )
    ).toHaveLength(2)

    const explicitlyDisabled = Schema.decodeUnknownSync(IrregularNestingSettings)({
      ...compactQualityNoRepairSettings,
      optimizer: {
        ...compactQualityNoRepairSettings.optimizer,
        canonicalReferenceDecodeEnabled: false
      }
    })
    expect(
      canonicalReferenceDecodeSheets(
        nonReferenceRequest,
        explicitlyDisabled,
        mixedScalePrepared
      )
    ).toHaveLength(1)
  })

  it('keeps repair, GA, and short-side-fill jobs on one decode', () => {
    const settings = (overrides: Record<string, unknown>) =>
      Schema.decodeUnknownSync(IrregularNestingSettings)({
        ...canonicalSettings,
        optimizer: { ...canonicalSettings.optimizer, ...overrides }
      })
    for (const ineligible of [
      settings({ localRepairBudget: 1 }),
      settings({ gaEnabled: true, baselineOnly: false }),
      settings({ placementPolicyId: 'short-side-fill' })
    ]) {
      expect(
        canonicalReferenceDecodeSheets(nonReferenceRequest, ineligible, mixedScalePrepared)
      ).toHaveLength(1)
    }
  })

  it('accepts the measured 57/17 to 53/14 contact trade within named slacks', () => {
    expect(CANONICAL_REFERENCE_ADMISSION_SLACKS).toEqual({
      maximumMaxSideRegressionRatio: 0.075,
      maximumTotalContactLoss: 4,
      maximumDominantContactLoss: 3
    })
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: canonicalScore(),
        canonicalTopology: topology
      }).admitted
    ).toBe(true)
  })

  it('rejects one unit beyond either contact loss slack', () => {
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score({
          collisionBoundsAreaMm2: 430_000,
          collisionBoundsSpanMm: 1_420,
          nearCompleteStructuralContactCount: 52,
          dominantNearCompleteStructuralContactCount: 14
        }),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score({
          collisionBoundsAreaMm2: 430_000,
          collisionBoundsSpanMm: 1_420,
          nearCompleteStructuralContactCount: 53,
          dominantNearCompleteStructuralContactCount: 13
        }),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
  })

  it('rejects fragmented low-gap candidates and score ties', () => {
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: canonicalScore(),
        canonicalTopology: {
          largestOccupiedHullGapRatio: 0.1,
          positiveContactComponentCount: 12,
          isolatedPieceCount: 8,
          largestPositiveContactComponentSize: 20
        }
      }).admitted
    ).toBe(false)
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score(),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
  })
})
