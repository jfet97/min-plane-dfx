import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'
import { computeIrregularNesting } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

const TRIANGLE_COUNT = 20
const MAX_COLLISION_SHORT_SIDE_MM = 228
const MAX_COLLISION_LONG_SIDE_MM = 354
const MAX_COLLISION_BOUNDS_AREA_MM2 = 80_200
const MAX_COLLISION_BOUNDS_SPAN_MM = 581
const MAX_OCCUPIED_HULL_WASTE_RATIO = 0.05

const settings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})

function makeTriangleRequest(): NestingRequest {
  const preset = makePresetShapeDocument({
    kind: 'triangle',
    width: 70,
    height: 60,
    label: 'triangle'
  })
  const triangle = preset.pieces[0]
  if (triangle === undefined) throw new Error('triangle preset must contain one piece')

  const sources = Array.from(
    { length: TRIANGLE_COUNT },
    (_, index) =>
      new ImportedPiece({
        ...triangle,
        id: PieceId.make(`triangle-copy-${index + 1}`),
        sourceFileId: SourceFileId.make(`triangle-source-copy-${index + 1}`),
        label: `triangle copy ${index + 1}`
      })
  )
  const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'triangle golden' })
  const jobId = JobId.make('triangle-compact-golden')
  const prepared = preparePieces(
    sources,
    sheet,
    10,
    jobId,
    undefined,
    undefined,
    () => 'triangle-70x60'
  )
  expect(prepared.warnings).toEqual([])

  return new NestingRequest({
    version: 1,
    jobId,
    sheet,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 60_000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

function collisionBounds(
  polygons: ReadonlyArray<{ readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }> }>
): { readonly minX: number; readonly minY: number; readonly width: number; readonly height: number } {
  const points = polygons.flatMap((polygon) => polygon.points)
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

describe('compact-quality repeated triangle golden', () => {
  it(
    'keeps all 20 pointed triangles in a dense bottom-left lattice',
    async () => {
      const request = makeTriangleRequest()
      const optimizer = settings.optimizer

      expect(optimizer).toMatchObject({
        orderWindow: 4,
        beamWidth: 8,
        localCandidateFanout: 4,
        localRepairBudget: 8,
        transformCap: 8,
        baselineOnly: true,
        gaEnabled: false,
        placementPolicyId: 'edge-contact-then-balanced-compactness'
      })

      const computed = await Effect.runPromise(
        computeIrregularNesting(request).pipe(
          Effect.provide(CollisionGeometryBuilder.Live),
          Effect.provide(TransformGeneratorLive),
          Effect.provide(NfpIfpServiceLive),
          Effect.provide(FreeMaterialServiceLive),
          Effect.provide(IrregularPlacementScorer.Live),
          Effect.provide(IrregularLayoutScorer.Live),
          Effect.provide(Layer.succeed(GeometrySettings, settings))
        )
      )
      const output = makeIrregularWorkerOutput({
        request,
        computed,
        algorithmBenchmark: {
          startedAt: '2026-07-17T00:00:00.000Z',
          endedAt: '2026-07-17T00:00:01.000Z',
          elapsedMs: 1000
        }
      })
      const layout = output.result.layout
      if (layout === undefined || layout.kind !== 'irregular') {
        throw new Error('triangle golden must produce an irregular layout')
      }
      const polygons = layout.collisionPolygons ?? []
      const bounds = collisionBounds(polygons)
      const winnerScore = computed.portfolio.score
      if (winnerScore === undefined) throw new Error('triangle golden must retain a winner score')

      expect(layout.placements).toHaveLength(TRIANGLE_COUNT)
      expect(polygons).toHaveLength(TRIANGLE_COUNT)
      expect(polygons.every((polygon) => polygon.points.length === 3)).toBe(true)
      expect(layout.unplacedPieceIds).toEqual([])
      expect(computed.unplacedPieceIds).toEqual([])

      expect(bounds.minX).toBeCloseTo(0, 6)
      expect(bounds.minY).toBeCloseTo(0, 6)
      expect(Math.min(bounds.width, bounds.height)).toBeLessThanOrEqual(
        MAX_COLLISION_SHORT_SIDE_MM
      )
      expect(Math.max(bounds.width, bounds.height)).toBeLessThanOrEqual(
        MAX_COLLISION_LONG_SIDE_MM
      )
      expect(computed.score.collisionBoundsAreaMm2).toBeLessThanOrEqual(
        MAX_COLLISION_BOUNDS_AREA_MM2
      )
      expect(computed.score.collisionBoundsSpanMm).toBeLessThanOrEqual(
        MAX_COLLISION_BOUNDS_SPAN_MM
      )
      expect(computed.score.occupiedHullWasteRatio).toBeLessThanOrEqual(
        MAX_OCCUPIED_HULL_WASTE_RATIO
      )
      expect(computed.score.collisionBoundsLeftMm).toBeCloseTo(0, 6)
      expect(computed.score.collisionBoundsBottomMm).toBeCloseTo(0, 6)

      expect(winnerScore.nearCompleteStructuralContactCount).toBeGreaterThanOrEqual(24)
      expect(winnerScore.dominantNearCompleteStructuralContactCount).toBeGreaterThanOrEqual(17)
      expect(winnerScore.sharedCollisionBoundaryContactUnits).toBeGreaterThanOrEqual(23.8)
      expect(winnerScore.sharedCollisionBoundaryContactBand).toBeGreaterThanOrEqual(23)
      expect(winnerScore.sharedCollisionBoundaryLengthMm).toBeGreaterThanOrEqual(2100)
      expect(winnerScore.freeMaterialRegionCount).toBe(1)
      expect(winnerScore.freeMaterialHoleCount).toBe(0)

      expect(computed.score.sharedCollisionBoundaryLengthMm).toBe(
        winnerScore.sharedCollisionBoundaryLengthMm
      )
      expect(computed.score.sharedCollisionBoundaryContactUnits).toBe(
        winnerScore.sharedCollisionBoundaryContactUnits
      )
      expect(computed.score.sharedCollisionBoundaryContactBand).toBe(
        winnerScore.sharedCollisionBoundaryContactBand
      )
      expect(computed.score.nearCompleteStructuralContactCount).toBe(
        winnerScore.nearCompleteStructuralContactCount
      )
      expect(computed.score.dominantNearCompleteStructuralContactCount).toBe(
        winnerScore.dominantNearCompleteStructuralContactCount
      )
      expect(layout.score.sharedCollisionBoundaryLengthMm).toBe(
        winnerScore.sharedCollisionBoundaryLengthMm
      )
      expect(layout.score.sharedCollisionBoundaryContactUnits).toBe(
        winnerScore.sharedCollisionBoundaryContactUnits
      )
      expect(layout.score.sharedCollisionBoundaryContactBand).toBe(
        winnerScore.sharedCollisionBoundaryContactBand
      )
      expect(layout.score.nearCompleteStructuralContactCount).toBe(
        winnerScore.nearCompleteStructuralContactCount
      )
      expect(layout.score.dominantNearCompleteStructuralContactCount).toBe(
        winnerScore.dominantNearCompleteStructuralContactCount
      )
    },
    30_000
  )
})
