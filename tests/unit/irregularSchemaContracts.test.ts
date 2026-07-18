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
  DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS,
  DEFAULT_IRREGULAR_WORKER_TIMEOUT_MS,
  makeCompactQualityIrregularOptimizerSettings,
  makeDefaultIrregularNestingSettings,
  makeDerivedOrientationIrregularOptimizerSettings,
  makeFastIdentityIrregularOptimizerSettings,
  makeOrthogonalIrregularOptimizerSettings,
  workerTimeoutForMode
} from '@shared/irregular/defaults.js'
import {
  NestingHistoryFramePayload,
  NestingLayout,
  NestingResult
} from '@shared/domain/nesting.js'
/** Decodes an unknown value through one schema without constructing invalid classes directly. */
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) {
  return Schema.decodeUnknownExit(schema)(input)
}

describe('irregular worker defaults', () => {
  it('raises only irregular jobs to the measured-safe timeout floor', () => {
    expect(DEFAULT_IRREGULAR_WORKER_TIMEOUT_MS).toBe(120_000)
    expect(workerTimeoutForMode('irregular-convex-v2', 30_000)).toBe(120_000)
    expect(workerTimeoutForMode('irregular-convex-v2', 180_000)).toBe(180_000)
    expect(workerTimeoutForMode('maxrects-beam-search', 30_000)).toBe(30_000)
  })
})

describe('irregular schema contracts', () => {
  it('ships an independent, deterministic first-result profile', () => {
    const first = makeDefaultIrregularNestingSettings()
    const second = makeDefaultIrregularNestingSettings()

    expect(first.optimizer.orderWindow).toBe(1)
    expect(first.optimizer.beamWidth).toBe(1)
    expect(first.optimizer.localCandidateFanout).toBe(4)
    expect(first.optimizer.localRepairBudget).toBe(0)
    expect(first.optimizer.transformCap).toBe(16)
    expect(first.optimizer.edgeAlignmentEnabled).toBe(true)
    expect(first.optimizer.gaEnabled).toBe(false)
    expect(first.optimizer.baselineOnly).toBe(true)
    expect(first.geometry).not.toBe(second.geometry)
    expect(first.optimizer).not.toBe(second.optimizer)
    expect(first.optimizer.configuredRotationDeg).not.toBe(second.optimizer.configuredRotationDeg)
    expect(second.optimizer.configuredRotationDeg).toEqual([])
    expect(DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS.configuredRotationDeg).toEqual([])
  })

  it('provides concrete transform profiles with caller overrides', () => {
    const fast = makeFastIdentityIrregularOptimizerSettings()
    const orthogonal = makeOrthogonalIrregularOptimizerSettings()
    const derived = makeDerivedOrientationIrregularOptimizerSettings({
      configuredRotationDeg: [12.5],
      transformCap: 8,
      edgeAlignmentEnabled: false
    })

    expect(fast).toMatchObject({
      transformCap: 1,
      configuredRotationEnabled: false,
      edgeAlignmentEnabled: false,
      configuredRotationDeg: []
    })
    expect(orthogonal).toMatchObject({
      transformCap: 4,
      configuredRotationEnabled: false,
      edgeAlignmentEnabled: false,
      configuredRotationDeg: []
    })
    expect(derived).toMatchObject({
      transformCap: 8,
      configuredRotationEnabled: true,
      edgeAlignmentEnabled: false,
      configuredRotationDeg: [12.5]
    })
    expect(fast).not.toBe(orthogonal)
    expect(fast.configuredRotationDeg).not.toBe(orthogonal.configuredRotationDeg)
  })

  it('provides the measured beam-eight compact-quality profile', () => {
    const quality = makeCompactQualityIrregularOptimizerSettings()

    expect(quality).toMatchObject({
      orderWindow: 4,
      beamWidth: 8,
      localCandidateFanout: 4,
      localRepairBudget: 8,
      transformCap: 8,
      configuredRotationEnabled: true,
      edgeAlignmentEnabled: true,
      baselineOnly: true,
      gaEnabled: false,
      placementPolicyId: 'edge-contact-then-balanced-compactness'
    })
  })

  it('decodes older incomplete optimizer settings to the safe profile', () => {
    const decoded = decode(IrregularOptimizerSettings, {
      orderWindow: 1,
      beamWidth: 1,
      transformCap: 1,
      gaPopulation: 1,
      gaTimeBudgetMs: 1,
      gaSeed: 'legacy-settings'
    })

    if (Exit.isFailure(decoded)) throw new Error('expected legacy settings to decode')
    expect(decoded.value.localCandidateFanout).toBe(4)
    expect(decoded.value.localRepairBudget).toBe(0)
    expect(decoded.value.edgeAlignmentEnabled).toBe(true)
    expect(decoded.value.gaEnabled).toBe(false)
    expect(decoded.value.baselineOnly).toBe(true)
  })

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
      localRepairBudget: 5,
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
    expect(decoded.value.localRepairBudget).toBe(5)
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
          localRepairBudget: -1
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
      sharedCollisionBoundaryLengthMm: 42,
      sharedCollisionBoundaryContactUnits: 3.25,
      sharedCollisionBoundaryContactBand: 3,
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

    const layout = decode(IrregularLayout, {
      kind: 'irregular',
      placements: [placement],
      unplacedPieceIds: ['copy-2'],
      score,
      source: 'beam',
      status: 'completed',
      diagnostics: []
    })
    if (Exit.isFailure(layout)) throw new Error('expected a valid irregular layout')
    expect(layout.value.collisionPolygons).toEqual([])

    const historyFrame = decode(IrregularHistoryFrame, {
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
    if (Exit.isFailure(historyFrame)) throw new Error('expected a valid irregular history frame')
    expect(historyFrame.value.collisionPolygons).toEqual([])
  })

  it('rejects collision hulls that do not align with irregular placements', () => {
    const decoded = decode(IrregularLayout, {
      kind: 'irregular',
      placements: [],
      collisionPolygons: [{ points: [{ x: 0, y: 0 }] }],
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
      source: 'beam',
      status: 'completed',
      diagnostics: []
    })

    expect(Exit.isFailure(decoded)).toBe(true)
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
