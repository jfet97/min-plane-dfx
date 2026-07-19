import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  decodeIntrinsicStrictPriorityOrder,
  rankIntrinsicStrictCompletedLayouts,
  type IntrinsicStrictCompletedMetrics
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { assertCanonicalGridLegalLayout } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { NfpIfpService } from '../../src/workers/irregular/services.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function transform(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored: false,
    reason: 'configured'
  })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transforms: ReadonlyArray<IrregularTransformCandidate>
): IrregularPreparedPiece {
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: bounds(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

function decode(finalSheet: SheetSpec, pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return Effect.runPromise(
    decodeIntrinsicStrictPriorityOrder(finalSheet, pieces).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function decodeWithCandidateService(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  nfpLayer: Layer.Layer<NfpIfpService>
) {
  return Effect.runPromise(
    decodeIntrinsicStrictPriorityOrder(finalSheet, pieces).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(nfpLayer)
    )
  )
}

describe('decodeIntrinsicStrictPriorityOrder', () => {
  it('keeps one canonical layout across differently sized legal sheets', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]

    const landscape = await decode(sheet(20, 10), pieces)
    const portrait = await decode(sheet(10, 20), pieces)

    expect(landscape.status).toBe('completed')
    expect(portrait.status).toBe('completed')
    expect(landscape.canonicalGeometryHash).toBe(portrait.canonicalGeometryHash)
    expect(landscape.placements).toEqual(portrait.placements)
    expect(landscape.unplacedPieceIds).toEqual([])
    expect(landscape.certificate?.passes).toBe(true)
    expect(assertCanonicalGridLegalLayout(sheet(20, 10), landscape.placedCollisionGeometries)).toBe(
      true
    )
  })

  it('anchors the first transformed collision polygon at the normalized origin', async () => {
    const centered = [point(-2, -1), point(2, -1), point(2, 1), point(-2, 1)]
    const result = await decode(sheet(10, 10), [
      preparedPiece('centered', centered, [transform(0, 90)])
    ])

    expect(result.status).toBe('completed')
    expect(result.placedCollisionGeometries[0]?.placement.transform.translateX).toBe(1)
    expect(result.placedCollisionGeometries[0]?.placement.transform.translateY).toBe(2)
    expect(result.metrics?.envelopeMaximumSideMm).toBe(4)
  })

  it('preserves the best candidate from each transform family before selection', async () => {
    const candidateDomains: Array<string | undefined> = []
    const candidateService = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving, candidateDomain }) => {
        candidateDomains.push(candidateDomain)
        const candidatePoint = moving.transform.rotationDeg === 0 ? point(2, 0) : point(3, 0)
        return Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: candidatePoint,
            diagnostics: []
          })
        ])
      }
    })
    const result = await decodeWithCandidateService(
      sheet(20, 20),
      [
        preparedPiece('anchor', rectanglePoints(2, 2), [transform(0, 0)]),
        preparedPiece('family', rectanglePoints(4, 1), [transform(0, 0), transform(1, 90)])
      ],
      candidateService
    )

    expect(result.status).toBe('completed')
    expect(result.stepTrace[1]).toMatchObject({
      candidateCount: 2,
      transformFamilyCount: 2,
      selectedTransformFamily: '90:0'
    })
    expect(result.placements[1]?.transform.rotationDeg).toBe(90)
    expect(candidateDomains).toEqual([
      'sheetless-contact-only',
      'sheetless-contact-only'
    ])
  })

  it('orders floor passers before chain and fragment failures without buying topology by area', () => {
    const base: IntrinsicStrictCompletedMetrics = {
      envelopeMaximumSideMm: 100,
      envelopeAreaMm2: 8_000,
      envelopeSpanMm: 180,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      largestOccupiedHullGapRatio: 0.05,
      isolatedPieceCount: 0,
      largestPositiveContactComponentSize: 10,
      largestPositiveContactComponentRatio: 1,
      occupiedAreaOutsideLargestContactComponentMm2: 0,
      occupiedHullWasteRatio: 0.05,
      totalStructuralContacts: 9,
      dominantStructuralContacts: 9,
      contactUnits: 9,
      sharedBoundaryLengthMm: 90,
      canonicalGeometryHash: 'cohesive',
      runtimeMs: 1
    }
    const chain = {
      ...base,
      envelopeMaximumSideMm: 500,
      envelopeAreaMm2: 5_000,
      envelopeSpanMm: 510,
      largestOccupiedHullGapRatio: 0.3,
      canonicalGeometryHash: 'chain'
    }
    const fragment = {
      ...base,
      envelopeMaximumSideMm: 50,
      envelopeAreaMm2: 2_500,
      envelopeSpanMm: 100,
      isolatedPieceCount: 5,
      largestPositiveContactComponentRatio: 0.4,
      canonicalGeometryHash: 'fragment'
    }

    expect(
      rankIntrinsicStrictCompletedLayouts([fragment, chain, base]).map(
        ({ canonicalGeometryHash }) => canonicalGeometryHash
      )
    ).toEqual(['cohesive', 'chain', 'fragment'])
  })
})
