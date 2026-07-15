import { Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularHistoryFrame,
  IrregularIfpBounds,
  IrregularLayout,
  IrregularLayoutScoreSummary,
  IrregularOptimizerSettings,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  FreeMaterialSnapshot,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  NestingHistoryFramePayload,
  NestingLayout,
  NestingResult
} from '@shared/domain/nesting.js'

/** Decodes an unknown value through one schema without constructing invalid classes directly. */
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) {
  return Schema.decodeUnknownExit(schema)(input)
}

describe('irregular schema contracts', () => {
  it('requires finite coordinates and ordered bounds', () => {
    expect(Exit.isSuccess(decode(IrregularPoint, { x: -2.5, y: 4 }))).toBe(true)
    expect(Exit.isFailure(decode(IrregularPoint, { x: Number.NaN, y: 4 }))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularBounds, { minX: 4, minY: 0, maxX: 3, maxY: 10 })
      )
    ).toBe(true)
  })

  it('requires finite indexed transform candidates and preserves periodic angles', () => {
    expect(
      Exit.isSuccess(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 450,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 1.5,
          rotationDeg: 90,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: Number.POSITIVE_INFINITY,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 90,
          mirrored: false,
          reason: 'unsupported'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 0,
          mirrored: false,
          reason: 'oriented_bounds'
        })
      )
    ).toBe(true)
  })

  it('requires conservative geometry settings', () => {
    const valid = {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'test-backend',
      geometryBackendVersion: '1'
    }

    expect(Exit.isSuccess(decode(IrregularGeometrySettings, valid))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          flatteningSagToleranceMm: 0
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          clearanceSafetyMarginMm: 0.1
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          geometryBackendVersion: ''
        })
      )
    ).toBe(true)
  })

  it('requires positive integer optimizer controls', () => {
    const valid = {
      orderWindow: 2,
      beamWidth: 24,
      transformCap: 16,
      gaPopulation: 32,
      gaTimeBudgetMs: 60_000,
      gaSeed: 'test-seed'
    }

    expect(Exit.isSuccess(decode(IrregularOptimizerSettings, valid))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, orderWindow: 0 })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, gaTimeBudgetMs: 1.5 })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, gaSeed: '' })
      )
    ).toBe(true)
  })

  it('decodes bounded experiment controls and rejects inconsistent policy choices', () => {
    const valid = {
      orderWindow: 3,
      beamWidth: 12,
      localCandidateFanout: 5,
      transformCap: 8,
      gaPopulation: 10,
      gaGenerationBudget: 2,
      gaEvaluationBudget: 20,
      gaTimeBudgetMs: 0,
      gaSeed: 'experiment-seed',
      configuredRotationEnabled: false,
      configuredRotationDeg: [15, 45],
      gaEnabled: false,
      baselineOnly: true,
      priorityOrderMutationEnabled: false,
      transformPreferenceMutationEnabled: false,
      placementPolicyMutationEnabled: false,
      placementPolicyId: 'short-side-fill',
      placementPolicyIds: ['short-side-fill']
    }

    const decoded = decode(IrregularOptimizerSettings, valid)
    if (Exit.isFailure(decoded)) throw new Error('expected valid experiment controls')
    expect(decoded.value.localCandidateFanout).toBe(5)
    expect(decoded.value.gaTimeBudgetMs).toBe(0)
    expect(decoded.value.placementPolicyId).toBe('short-side-fill')

    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, {
          ...valid,
          localCandidateFanout: 0
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, {
          ...valid,
          placementPolicyIds: ['balanced-compactness']
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, {
          ...valid,
          placementPolicyIds: ['short-side-fill', 'short-side-fill']
        })
      )
    ).toBe(true)
  })

  it('keeps polygon vertices schema-backed as finite points', () => {
    expect(
      Exit.isSuccess(
        decode(IrregularPolygon, {
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 0, y: 3 }
          ]
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularPolygon, {
          points: [
            { x: 0, y: 0 },
            { x: Number.NEGATIVE_INFINITY, y: 0 },
            { x: 0, y: 3 }
          ]
        })
      )
    ).toBe(true)
  })

  it('retains prepared and source identities on new irregular placements', () => {
    const result = decode(IrregularPlacement, {
      pieceId: 'copy-1',
      sourcePieceId: 'source-1',
      transform: { translateX: 4, translateY: 5, rotationDeg: 90, mirrored: false }
    })

    if (Exit.isFailure(result)) throw new Error('expected a valid irregular placement')
    expect(result.value.pieceId).toBe('copy-1')
    expect(result.value.sourcePieceId).toBe('source-1')
  })

  it('decodes legacy irregular placements without fabricating a prepared identity', () => {
    const result = decode(IrregularPlacement, {
      sourcePieceId: 'source-1',
      transform: { translateX: 4, translateY: 5, rotationDeg: 90, mirrored: false }
    })

    if (Exit.isFailure(result)) throw new Error('expected a legacy placement to decode')
    expect(result.value.pieceId).toBeUndefined()
  })

  it('uses named whole-layout criteria instead of numeric score tuples', () => {
    const score = {
      unplacedCount: 1,
      largestNetFreeMaterialRegionAreaMm2: 200,
      freeMaterialRegionCount: 2,
      freeMaterialHoleCount: 1,
      freeMaterialSliverMetric: 3.5,
      collisionBoundsWorstNormalizedSheetConsumption: 0.75,
      collisionBoundsNormalizedSpanSum: 1.2,
      collisionBoundsAreaMm2: 500,
      collisionBoundsSpanMm: 45
    }

    expect(Exit.isSuccess(decode(IrregularLayoutScoreSummary, score))).toBe(true)
    expect(
      Exit.isSuccess(
        decode(IrregularPortfolioProgress, {
          phase: 'deterministic_beam',
          bestScore: score,
          elapsedMs: 10
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularPortfolioResult, {
          status: 'completed',
          source: 'beam',
          placements: [],
          unplacedPieceIds: [],
          score: [1, 2, 3],
          diagnostics: []
        })
      )
    ).toBe(true)
  })

  it('accepts irregular layout and history data without rectangular artifacts', () => {
    const placement = {
      pieceId: 'copy-1',
      sourcePieceId: 'source-1',
      transform: { translateX: 4, translateY: 5, rotationDeg: 0, mirrored: false }
    }
    const score = {
      unplacedCount: 0,
      largestNetFreeMaterialRegionAreaMm2: 200,
      freeMaterialRegionCount: 1,
      freeMaterialHoleCount: 0,
      freeMaterialSliverMetric: 2,
      collisionBoundsWorstNormalizedSheetConsumption: 0.5,
      collisionBoundsNormalizedSpanSum: 0.8,
      collisionBoundsAreaMm2: 100,
      collisionBoundsSpanMm: 20
    }

    expect(
      Exit.isSuccess(
        decode(IrregularLayout, {
          kind: 'irregular',
          placements: [placement],
          unplacedPieceIds: ['copy-2'],
          score,
          source: 'beam',
          status: 'completed',
          diagnostics: []
        })
      )
    ).toBe(true)
    expect(
      Exit.isSuccess(
        decode(IrregularHistoryFrame, {
          kind: 'irregular',
          frameId: 'frame-1',
          jobId: 'job-1',
          strategyRunId: 'run-1',
          strategyLabel: 'irregular beam',
          stepIndex: 2,
          title: 'beam step',
          placements: [placement],
          remainingPieceIds: ['copy-2'],
          unplacedPieceIds: [],
          beamRank: 0,
          beamWidth: 4,
          candidateCount: 3,
          selectedCandidateId: 'candidate-1',
          selectedPieceId: 'copy-1',
          selectedTransform: placement.transform,
          createdAt: '2026-07-15T00:00:00.000Z'
        })
      )
    ).toBe(true)
  })

  it('rejects rectangular placement fields that contradict an irregular layout', () => {
    const layout = {
      kind: 'irregular',
      placements: [],
      unplacedPieceIds: ['copy-1'],
      score: {
        unplacedCount: 1,
        largestNetFreeMaterialRegionAreaMm2: 0,
        freeMaterialRegionCount: 0,
        freeMaterialHoleCount: 0,
        freeMaterialSliverMetric: 0,
        collisionBoundsWorstNormalizedSheetConsumption: 0,
        collisionBoundsNormalizedSpanSum: 0,
        collisionBoundsAreaMm2: 0,
        collisionBoundsSpanMm: 0
      },
      source: 'beam',
      status: 'completed',
      diagnostics: []
    }
    const result = {
      version: 1,
      jobId: 'job-1',
      status: 'partial',
      strategyResults: [],
      sortedPieceIds: ['copy-1'],
      placements: [],
      unplacedPieceIds: ['copy-1'],
      layout,
      warnings: [],
      stats: {
        elapsedMs: 1,
        pieceCount: 1,
        algorithm: {
          startedAt: '2026-07-15T00:00:00.000Z',
          endedAt: '2026-07-15T00:00:00.001Z',
          elapsedMs: 1
        }
      }
    }

    expect(Exit.isSuccess(decode(NestingResult, result))).toBe(true)
    expect(
      Exit.isFailure(
        decode(NestingResult, {
          ...result,
          placements: [{ pieceId: 'copy-1', x: 0, y: 0, width: 1, height: 1, rotation: 0 }]
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(NestingResult, {
          ...result,
          unplacedPieceIds: []
        })
      )
    ).toBe(true)
  })

  it('initializes both domain modules before constructing cross-domain schemas', () => {
    const layout = {
      kind: 'irregular',
      placements: [],
      unplacedPieceIds: [],
      score: {
        unplacedCount: 0,
        largestNetFreeMaterialRegionAreaMm2: 0,
        freeMaterialRegionCount: 0,
        freeMaterialHoleCount: 0,
        freeMaterialSliverMetric: 0,
        collisionBoundsWorstNormalizedSheetConsumption: 0,
        collisionBoundsNormalizedSpanSum: 0,
        collisionBoundsAreaMm2: 0,
        collisionBoundsSpanMm: 0
      },
      source: 'none',
      status: 'no-valid-result',
      diagnostics: []
    }

    expect(Exit.isSuccess(decode(NestingLayout, layout))).toBe(true)
    expect(
      Exit.isSuccess(
        decode(NestingHistoryFramePayload, {
          kind: 'irregular',
          frameId: 'frame-1',
          jobId: 'job-1',
          strategyRunId: 'run-1',
          strategyLabel: 'irregular beam',
          stepIndex: 0,
          title: 'initial beam',
          placements: [],
          remainingPieceIds: ['copy-1'],
          unplacedPieceIds: [],
          beamRank: 0,
          beamWidth: 1,
          createdAt: '2026-07-15T00:00:00.000Z'
        })
      )
    ).toBe(true)
    expect(
      Exit.isSuccess(
        decode(IrregularIfpBounds, {
          sheet: { width: 100, height: 100, label: 'test' },
          movingPieceId: 'copy-1',
          bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }
        })
      )
    ).toBe(true)
    expect(
      Exit.isSuccess(
        decode(FreeMaterialSnapshot, {
          sheet: { width: 100, height: 100, label: 'test' },
          regions: [],
          diagnostics: []
        })
      )
    ).toBe(true)
  })
})
