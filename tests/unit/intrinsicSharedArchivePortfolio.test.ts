import { describe, expect, it } from 'vitest'
import {
  intrinsicSharedArchiveExperimentValid,
  intrinsicSharedPeriodicCatalogCoverageValid,
  intrinsicSharedPeriodicSelectionValid,
  normalizeIntrinsicSharedArchiveConstructedRun,
  retainRankedSharedArchive,
  selectIntrinsicSharedArchiveWinner,
  selectFittingSharedArchive,
  type IntrinsicSharedArchiveEndpoint
} from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'
import { PieceId } from '../../src/shared/domain/ids.js'
import type { IntrinsicStrictCompletedMetrics } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'

function metrics(hash: string, maximumSide: number): IntrinsicStrictCompletedMetrics {
  return {
    envelopeMaximumSideMm: maximumSide,
    envelopeAreaMm2: maximumSide * maximumSide,
    envelopeSpanMm: maximumSide * 2,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 2,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 1,
    dominantStructuralContacts: 1,
    contactUnits: 1,
    sharedBoundaryLengthMm: 1,
    canonicalGeometryHash: hash,
    runtimeMs: 1
  }
}

function endpoint(
  role: string,
  hash: string,
  maximumSide: number
): IntrinsicSharedArchiveEndpoint {
  return {
    role,
    sourceId: undefined,
    sheetlessCanonicalGeometryIdentity: `identity-${hash}`,
    sheetlessCanonicalGeometryHash: hash,
    placedCollisionGeometries: [],
    metrics: metrics(hash, maximumSide),
    certificate: { passes: true, violatedFloors: [], relativeDeficitSum: 0 },
    requestedSheetFit: {
      q0: { fits: true, canonicalGeometryHash: `fit-${hash}` },
      q90: { fits: false, canonicalGeometryHash: undefined },
      selectedRotationDeg: 0,
      selectedCanonicalGeometryHash: `fit-${hash}`,
      selectedPlacedCollisionGeometries: []
    }
  }
}

describe('retainRankedSharedArchive', () => {
  it('deduplicates by sheetless hash before applying the unchanged terminal rank', () => {
    const worseDuplicate = endpoint('periodic-P1', 'same', 20)
    const firstRepresentative = endpoint('canonical-grid', 'same', 10)
    const best = endpoint('open-pocket-first', 'best', 5)

    const ranked = retainRankedSharedArchive([firstRepresentative, worseDuplicate, best])

    expect(ranked.map(({ role }) => role)).toEqual(['open-pocket-first', 'canonical-grid'])
    expect(ranked.map(({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash)).toEqual([
      'best',
      'same'
    ])
  })

  it('keeps sheetless rank independent of requested-sheet fit', () => {
    const sheetlessBest = {
      ...endpoint('sheetless-best', 'best', 5),
      requestedSheetFit: {
        q0: { fits: false, canonicalGeometryHash: undefined },
        q90: { fits: false, canonicalGeometryHash: undefined },
        selectedRotationDeg: undefined,
        selectedCanonicalGeometryHash: undefined,
        selectedPlacedCollisionGeometries: []
      }
    }
    const fittingSecond = endpoint('fitting-second', 'second', 10)
    const sheetless = retainRankedSharedArchive([fittingSecond, sheetlessBest])

    expect(sheetless.map(({ role }) => role)).toEqual(['sheetless-best', 'fitting-second'])
    expect(selectFittingSharedArchive(sheetless).map(({ role }) => role)).toEqual([
      'fitting-second'
    ])
  })

  it('selects cohesive geometry from the first Pareto front instead of the smallest max side', () => {
    const narrowControl = {
      ...endpoint('legacy-absolute-envelope', 'narrow', 341.785),
      metrics: {
        ...metrics('narrow', 341.785),
        envelopeAreaMm2: 115_228.71133,
        envelopeSpanMm: 678.923,
        largestOccupiedHullGapRatio: 0.3312548377545349,
        isolatedPieceCount: 14,
        positiveContactComponentCount: 17,
        largestPositiveContactComponentSize: 2,
        largestPositiveContactComponentRatio: 0.1
      },
      certificate: {
        passes: false,
        violatedFloors: [
          'maximumIsolatedPieceCount',
          'minimumLargestPositiveContactComponentRatio',
          'maximumLargestOccupiedHullGapRatio'
        ],
        relativeDeficitSum: 2.875
      }
    } satisfies IntrinsicSharedArchiveEndpoint
    const twoBandLattice = {
      ...endpoint('periodic-P2', 'two-band', 487.983),
      metrics: {
        ...metrics('two-band', 487.983),
        envelopeAreaMm2: 74_428.143126,
        envelopeSpanMm: 640.505,
        largestOccupiedHullGapRatio: 0.029710516900773094,
        isolatedPieceCount: 10,
        positiveContactComponentCount: 11,
        largestPositiveContactComponentSize: 10,
        largestPositiveContactComponentRatio: 0.5
      },
      certificate: {
        passes: false,
        violatedFloors: [
          'maximumIsolatedPieceCount',
          'minimumLargestPositiveContactComponentRatio'
        ],
        relativeDeficitSum: 1.375
      }
    } satisfies IntrinsicSharedArchiveEndpoint

    expect(
      selectIntrinsicSharedArchiveWinner([narrowControl, twoBandLattice])
        ?.sheetlessCanonicalGeometryHash
    ).toBe('two-band')
  })

  it('does not let a cohesion certificate rescue geometrically dominated geometry', () => {
    const geometricallyBetter = {
      ...endpoint('compact', 'compact', 10),
      certificate: {
        passes: false,
        violatedFloors: ['maximumIsolatedPieceCount'],
        relativeDeficitSum: 1
      }
    } satisfies IntrinsicSharedArchiveEndpoint
    const dominatedButCertified = {
      ...endpoint('cohesive', 'cohesive', 20),
      metrics: {
        ...metrics('cohesive', 20),
        enclosedCavityCount: 1,
        largestOccupiedHullGapRatio: 0.1,
        occupiedHullWasteRatio: 0.1
      },
      certificate: { passes: true, violatedFloors: [], relativeDeficitSum: 0 }
    } satisfies IntrinsicSharedArchiveEndpoint

    expect(
      selectIntrinsicSharedArchiveWinner([dominatedButCertified, geometricallyBetter])
        ?.sheetlessCanonicalGeometryHash
    ).toBe('compact')
  })

  it('keeps evaluation-capped partial construction out of the endpoint archive', () => {
    const run = normalizeIntrinsicSharedArchiveConstructedRun({
      sheet: new SheetSpec({ width: 100, height: 100, label: 'test' }),
      role: 'periodic-P1',
      sourceId: 'source',
      requestedCandidateEvaluations: 1,
      constructed: {
        state: new IrregularBeamState({
          remainingPreparedPieces: [],
          placedCollisionGeometries: [],
          placementOrder: []
        }),
        stepTrace: [],
        gapFillEvidence: [],
        candidateEvaluationCount: 1,
        truncationReason: 'maximum-candidate-evaluations',
        runtimeMs: 1
      }
    })

    expect(run.status).toBe('evaluation-cap')
    expect(run.endpoint).toBeUndefined()
  })

  it('keeps an unplaced-piece construction out of the endpoint archive', () => {
    const run = normalizeIntrinsicSharedArchiveConstructedRun({
      sheet: new SheetSpec({ width: 100, height: 100, label: 'test' }),
      role: 'canonical-grid',
      sourceId: undefined,
      requestedCandidateEvaluations: undefined,
      constructed: {
        state: new IrregularBeamState({
          remainingPreparedPieces: [],
          placedCollisionGeometries: [],
          unplacedPieceIds: [PieceId.make('unplaced')],
          placementOrder: []
        }),
        stepTrace: [],
        gapFillEvidence: [],
        runtimeMs: 1
      }
    })

    expect(run.status).toBe('incomplete')
    expect(run.endpoint).toBeUndefined()
  })

  it('requires direct completion and uncensored periodic settlement', () => {
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        continuationCoverageComplete: false,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: true
      })
    ).toBe(true)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: false,
        continuationCoverageComplete: false,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: true
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        continuationCoverageComplete: false,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: false
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        continuationCoverageComplete: false,
        selectedContinuationCount: 7,
        runCount: 8,
        budgetSettlementComplete: true
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        continuationCoverageComplete: true,
        selectedContinuationCount: 0,
        runCount: 0,
        budgetSettlementComplete: true
      })
    ).toBe(true)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        continuationCoverageComplete: true,
        selectedContinuationCount: 3,
        runCount: 3,
        budgetSettlementComplete: true
      })
    ).toBe(true)
    expect(
      intrinsicSharedArchiveExperimentValid(
        [
          {
            status: 'completed',
            requestedCandidateEvaluations: 1,
            consumedCandidateEvaluations: 1
          },
          {
            status: 'completed',
            requestedCandidateEvaluations: 1,
            consumedCandidateEvaluations: 1
          },
          {
            status: 'evaluation-cap',
            requestedCandidateEvaluations: 1,
            consumedCandidateEvaluations: 1
          }
        ],
        [{ status: 'evaluation-cap' }],
        true
      )
    ).toBe(false)
    expect(
      intrinsicSharedArchiveExperimentValid(
        [
          {
            status: 'completed',
            requestedCandidateEvaluations: 1,
            consumedCandidateEvaluations: 1
          },
          {
            status: 'completed',
            requestedCandidateEvaluations: 2,
            consumedCandidateEvaluations: 2
          },
          {
            status: 'completed',
            requestedCandidateEvaluations: 3,
            consumedCandidateEvaluations: 3
          }
        ],
        [{ status: 'evaluation-cap' }, { status: 'completed' }],
        true
      )
    ).toBe(true)
    expect(
      intrinsicSharedArchiveExperimentValid(
        [
          {
            status: 'completed',
            requestedCandidateEvaluations: 2,
            consumedCandidateEvaluations: 1
          }
        ],
        [{ status: 'completed' }],
        true
      )
    ).toBe(false)
  })

  it('rejects runtime-censored catalogs while allowing fully captured deterministic caps', () => {
    expect(
      intrinsicSharedPeriodicCatalogCoverageValid({
        familyCoverageComplete: true,
        runtimeCoverageComplete: false,
        families: [],
        selectedFamilyKey: undefined,
        uniqueTransformCount: 0,
        enumeratedPairCount: 0,
        cells: [],
        rejected: {}
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicCatalogCoverageValid({
        familyCoverageComplete: false,
        runtimeCoverageComplete: true,
        families: [
          {
            familyKey: 'family',
            memberCount: 2,
            collisionAreaMm2: 1,
            uniqueTransformCount: 1,
            retainedTransformCount: 1,
            transformCoverageComplete: true,
            transformReservations: [],
            enumeratedPairCount: 1,
            pairCoverageComplete: true,
            edgeContactDiagnostics: {
              generatedRelationCount: 0,
              retainedRelationCount: 0,
              nonCollinearPairCount: 0,
              areaFeasiblePairCount: 0,
              validationAttemptCount: 0,
              validationCoverageComplete: true,
              latticeRejectedCount: 0,
              contactIncompleteCount: 0,
              admittedBasisCount: 0
            },
            cellCoverageComplete: false,
            sourceSurvival: [],
            sourceAuditCells: [],
            cells: [],
            rejected: {},
            rejectedSamples: []
          }
        ],
        selectedFamilyKey: 'family',
        uniqueTransformCount: 1,
        enumeratedPairCount: 1,
        cells: [],
        rejected: {}
      })
    ).toBe(true)
  })
})
