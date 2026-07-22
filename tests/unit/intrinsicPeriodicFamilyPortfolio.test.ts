import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  continuationsForExecution,
  type IntrinsicPeriodicContinuation,
  runIntrinsicPeriodicFamilyPortfolio
} from '../../src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function preparedTriangle(id: string): IrregularPreparedPiece {
  const points = [point(0, 0), point(4, 0), point(0, 2)]
  const polygon = new IrregularPolygon({ points })
  const source = new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 4, height: 2 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    interchangeabilityKey: 'triangle-family',
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 4, maxY: 2 }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [0, 90, 180, 270].map(
      (rotationDeg, index) =>
        new IrregularTransformCandidate({
          index,
          rotationDeg,
          mirrored: false,
          reason: 'orthogonal'
        })
    )
  })
}

describe('intrinsic periodic family portfolio', () => {
  it('runs each retained repeated-family seed independently through the strict archive', async () => {
    const pieces = Array.from({ length: 4 }, (_, index) => preparedTriangle(`triangle-${index}`))
    const result = await Effect.runPromise(
      runIntrinsicPeriodicFamilyPortfolio(
        new SheetSpec({ width: 100, height: 100, label: 'test' }),
        pieces,
        {
          maximumCatalogRuntimeMs: 1_000,
          maximumContinuationRuntimeMs: 1_000,
          maximumTotalRuntimeMs: 4_000
        }
      ).pipe(
        Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live))),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(result.catalog.families).toHaveLength(1)
    expect(result.runs).toHaveLength(result.continuations.length)
    expect(
      result.runs.every(
        ({ continuation, constructed }) =>
          constructed === undefined ||
          continuation.seed.placements.every(({ placement }) =>
            constructed.state.placedCollisionGeometries.some(
              ({ placement: placed }) => placed.pieceId === placement.pieceId
            )
          )
      )
    ).toBe(true)

  })

  it('reorders capped continuations by compact seed cost without changing uncapped order', () => {
    const prepared = preparedTriangle('seed-piece')
    const transform = prepared.transforms[0]
    if (transform === undefined) throw new Error('expected a transform fixture')
    const placed = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        pieceId: prepared.pieceId,
        sourcePieceId: prepared.source.id,
        placementReference: prepared.collisionGeometry.placementReference,
        transform: new IrregularTransform({
          translateX: 0,
          translateY: 0,
          rotationDeg: transform.rotationDeg,
          mirrored: transform.mirrored
        })
      }),
      collisionGeometry: new TransformedCollisionGeometry({
        sourcePieceId: prepared.source.id,
        transform,
        polygon: prepared.collisionGeometry.collisionPolygon,
        bounds: prepared.collisionGeometry.sourceBounds
      })
    })
    const continuation = (
      sourceId: string,
      envelopeAreaMm2: number,
      maximumSideMm: number,
      envelopeSpanMm: number,
      placedCount: number
    ): IntrinsicPeriodicContinuation => ({
      sourceId,
      role: 'P1',
      familyKey: 'family',
      cellKey: `cell-${sourceId}`,
      basisSourceKey: undefined,
      seed: {
        role: 'P1',
        cellKey: `cell-${sourceId}`,
        placements: Array.from({ length: placedCount }, () => placed),
        remainingFamilyMembers: [],
        componentCount: 1,
        isolatedPieceCount: 0,
        largestComponentSize: placedCount,
        maximumSideMm,
        envelopeAreaMm2,
        envelopeSpanMm,
        crop: { rows: 1, columns: 1, traversal: 'row', corner: 0 },
        canonicalKey: `seed-${sourceId}`
      }
    })
    const input = [
      continuation('large', 30, 6, 11, 4),
      continuation('few-placed', 10, 5, 9, 2),
      continuation('more-placed-z', 10, 5, 9, 4),
      continuation('more-placed-a', 10, 5, 9, 4),
      continuation('smaller-side', 10, 4, 10, 3)
    ]

    expect(continuationsForExecution(input, undefined)).toBe(input)
    expect(continuationsForExecution(input, 100).map(({ sourceId }) => sourceId)).toEqual([
      'smaller-side',
      'more-placed-a',
      'more-placed-z',
      'few-placed',
      'large'
    ])
  })

  it('admits raw-crop Pareto witnesses as source-tagged archive competitors on request', async () => {
    const pieces = Array.from({ length: 4 }, (_, index) => preparedTriangle(`triangle-${index}`))
    const run = (admitSourceAuditWitnesses: boolean) =>
      Effect.runPromise(
        runIntrinsicPeriodicFamilyPortfolio(
          new SheetSpec({ width: 100, height: 100, label: 'test' }),
          pieces,
          {
            maximumCatalogRuntimeMs: 1_000,
            maximumContinuationRuntimeMs: 1_000,
            maximumTotalRuntimeMs: 8_000,
            maximumContinuationCount: 1,
            captureSourceSurvivalAudit: true,
            admitSourceAuditWitnesses
          }
        ).pipe(
          Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live))),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    const withoutWitnesses = await run(false)
    const withWitnesses = await run(true)

    expect(
      withoutWitnesses.continuations.some(({ sourceId }) => sourceId.startsWith('raw-witness:'))
    ).toBe(false)
    const witnessContinuations = withWitnesses.continuations.filter(({ sourceId }) =>
      sourceId.startsWith('raw-witness:')
    )
    expect(
      witnessContinuations.length +
        withWitnesses.continuationOmissions.filter(({ sourceId }) =>
          sourceId.startsWith('raw-witness:')
        ).length
    ).toBeGreaterThan(0)
    // deduplication: no witness continuation repeats a selected canonical seed
    const selectedSeedKeys = new Set(
      withWitnesses.continuations
        .filter(({ sourceId }) => !sourceId.startsWith('raw-witness:'))
        .map(({ seed }) => seed.canonicalKey)
    )
    expect(
      witnessContinuations.every(({ seed }) => !selectedSeedKeys.has(seed.canonicalKey))
    ).toBe(true)
    expect(withWitnesses.runs).toHaveLength(withWitnesses.continuations.length)
    expect(withWitnesses.continuations.length).toBeLessThanOrEqual(1)
    expect(withWitnesses.continuationCoverageComplete).toBe(
      withWitnesses.continuationOmissions.every(({ reason }) => reason !== 'continuation-cap')
    )
  }, 30_000)
})
