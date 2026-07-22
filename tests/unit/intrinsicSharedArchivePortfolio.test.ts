import { describe, expect, it } from 'vitest'
import {
  intrinsicSharedArchiveExperimentValid,
  intrinsicSharedPeriodicSelectionValid,
  normalizeIntrinsicSharedArchiveConstructedRun,
  retainRankedSharedArchive,
  selectFittingSharedArchive,
  type IntrinsicSharedArchiveEndpoint
} from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'
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

  it('requires direct completion and uncensored periodic settlement', () => {
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: true
      })
    ).toBe(true)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: false,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: true
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        selectedContinuationCount: 8,
        runCount: 8,
        budgetSettlementComplete: false
      })
    ).toBe(false)
    expect(
      intrinsicSharedPeriodicSelectionValid({
        catalogRuntimeCoverageComplete: true,
        selectedContinuationCount: 7,
        runCount: 8,
        budgetSettlementComplete: true
      })
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
})
