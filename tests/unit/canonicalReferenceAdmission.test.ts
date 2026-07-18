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
  it('keeps the flagship sheet-invariance fixture explicitly on the protected role', () => {
    expect(mixedSettings.optimizer.canonicalReferenceDecodeEnabled).toBe(true)
    expect(
      isCanonicalReferenceRoleEligible(nonReferenceRequest, mixedSettings, mixedScalePrepared)
    ).toBe(true)
    expect(
      canonicalReferenceDecodeSheets(nonReferenceRequest, mixedSettings, mixedScalePrepared)
    ).toHaveLength(2)
  })

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
      isCanonicalReferenceRoleEligible(nonReferenceRequest, mixedSettings, mixedScalePrepared)
    ).toBe(true)
    expect(
      canonicalReferenceDecodeSheets(nonReferenceRequest, mixedSettings, mixedScalePrepared)
    ).toHaveLength(2)

    const referenceRequest = new NestingRequest({
      ...mixedRequest,
      sheet:
        canonicalReferenceDecodeSheets(nonReferenceRequest, mixedSettings, mixedScalePrepared)[1] ??
        mixedRequest.sheet
    })
    expect(
      canonicalReferenceDecodeSheets(referenceRequest, mixedSettings, mixedScalePrepared)
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
      canonicalReferenceDecodeSheets(homogeneousRequest, mixedSettings, homogeneousPrepared)
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(homogeneousRequest, mixedSettings, mixedScalePrepared)
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(
        nonReferenceRequest,
        mixedSettings,
        uniformMultiFamilyPrepared
      )
    ).toHaveLength(1)
    expect(
      canonicalReferenceDecodeSheets(
        new NestingRequest({ ...homogeneousRequest, pieces: homogeneousRequest.pieces.slice(0, 20) }),
        mixedSettings,
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
        ...mixedSettings,
        optimizer: { ...mixedSettings.optimizer, ...overrides }
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

  it('waives max-side slack for the structurally dominant 1000x1700 finalist', () => {
    const productionMaxSideMm = 700.365
    const canonicalMaxSideMm = 788.878
    const productionAreaMm2 = 461_476
    const canonicalAreaMm2 = 430_344
    const productionScore = score({
      collisionBoundsAreaMm2: productionAreaMm2,
      collisionBoundsSpanMm: productionMaxSideMm + productionAreaMm2 / productionMaxSideMm,
      freeMaterialHoleCount: 10,
      nearCompleteStructuralContactCount: 44,
      dominantNearCompleteStructuralContactCount: 9
    })
    const measuredCanonicalScore = score({
      collisionBoundsAreaMm2: canonicalAreaMm2,
      collisionBoundsSpanMm: canonicalMaxSideMm + canonicalAreaMm2 / canonicalMaxSideMm,
      freeMaterialHoleCount: 2,
      nearCompleteStructuralContactCount: 53,
      dominantNearCompleteStructuralContactCount: 14
    })
    const productionTopology: CanonicalLayoutTopology = {
      largestOccupiedHullGapRatio: 0.228,
      positiveContactComponentCount: 13,
      isolatedPieceCount: 6,
      largestPositiveContactComponentSize: 20
    }
    const canonicalTopology: CanonicalLayoutTopology = {
      largestOccupiedHullGapRatio: 0.119,
      positiveContactComponentCount: 5,
      isolatedPieceCount: 2,
      largestPositiveContactComponentSize: 53
    }

    expect(canonicalMaxSideMm / productionMaxSideMm - 1).toBeGreaterThan(0.075)
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: productionScore,
        productionTopology,
        canonical: measuredCanonicalScore,
        canonicalTopology
      })
    ).toEqual({ admitted: true, reason: 'canonical role passed every exact admission guard' })
  })

  it('keeps the max-side cap for a contact-non-dominant long-chain finalist', () => {
    const productionMaxSideMm = 700.365
    const canonicalMaxSideMm = 788.878
    const productionAreaMm2 = 461_476
    const canonicalAreaMm2 = 430_344
    const decision = evaluateCanonicalReferenceAdmissionMetrics({
      production: score({
        collisionBoundsAreaMm2: productionAreaMm2,
        collisionBoundsSpanMm: productionMaxSideMm + productionAreaMm2 / productionMaxSideMm,
        freeMaterialHoleCount: 10,
        nearCompleteStructuralContactCount: 44,
        dominantNearCompleteStructuralContactCount: 9
      }),
      productionTopology: {
        largestOccupiedHullGapRatio: 0.228,
        positiveContactComponentCount: 13,
        isolatedPieceCount: 6,
        largestPositiveContactComponentSize: 20
      },
      canonical: score({
        collisionBoundsAreaMm2: canonicalAreaMm2,
        collisionBoundsSpanMm: canonicalMaxSideMm + canonicalAreaMm2 / canonicalMaxSideMm,
        freeMaterialHoleCount: 2,
        nearCompleteStructuralContactCount: 43,
        dominantNearCompleteStructuralContactCount: 9
      }),
      canonicalTopology: {
        largestOccupiedHullGapRatio: 0.119,
        positiveContactComponentCount: 5,
        isolatedPieceCount: 2,
        largestPositiveContactComponentSize: 53
      }
    })

    expect(decision).toEqual({
      admitted: false,
      reason: 'max side exceeded the protected-role admission slack'
    })
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
